//! DeepSeek API executor client for ARIS.
//!
//! This executor handles DeepSeek's API which has slight differences from
//! the OpenAI-compatible format. DeepSeek-v4-flash does NOT use reasoning_content
//! in request payloads, even though it may emit thinking blocks in responses.

use std::io::{self, Write};

use crate::render::{MarkdownStreamState, TerminalRenderer};
use runtime::{
    ApiClient, ApiRequest, AssistantEvent, ContentBlock, ConversationMessage, MessageRole,
    RuntimeError, TokenUsage,
};
use serde_json::{json, Value};
use tools::ToolSpec;

use crate::{filter_tool_specs, format_tool_call_start, AllowedToolSet};

/// Whether this model emits reasoning_content blocks in the response that
/// we should cache and replay on subsequent turns.
#[must_use]
fn supports_reasoning_content_replay(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    // DeepSeek-v4-flash DOES emit reasoning_content and needs it replayed
    if m.contains("deepseek") {
        return true;
    }
    m.contains("deepseek-r1") || m.contains("-r1")
}

/// Resolve DeepSeek executor configuration from environment variables.
pub fn resolve_deepseek_executor_config() -> Option<DeepSeekExecutorConfig> {
    // Check if DeepSeek API key is available directly, or if EXECUTOR_PROVIDER is "deepseek"
    let provider = std::env::var("EXECUTOR_PROVIDER").ok();
    let has_deepseek_key = std::env::var("DEEPSEEK_API_KEY").is_ok();
    let has_executor_key = std::env::var("EXECUTOR_API_KEY").is_ok();

    // Use DeepSeek if: explicitly set as provider, OR DEEPSEEK_API_KEY is set (regardless of EXECUTOR_PROVIDER)
    let use_deepseek = provider.as_deref() == Some("deepseek") || has_deepseek_key;

    if !use_deepseek {
        eprintln!("\x1b[33mDeepSeek not selected: provider={:?}, has_deepseek_key={}, has_executor_key={}\x1b[0m", provider, has_deepseek_key, has_executor_key);
        return None;
    }

    let api_key = std::env::var("DEEPSEEK_API_KEY")
        .or_else(|_| std::env::var("EXECUTOR_API_KEY"))
        .ok()
        .filter(|s| !s.is_empty())?;

    // Use DeepSeek-specific base URL if set, otherwise use default
    let base_url = std::env::var("DEEPSEEK_BASE_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://api.deepseek.com/v1".to_string());

    Some(DeepSeekExecutorConfig { api_key, base_url })
}

#[derive(Debug, Clone)]
pub struct DeepSeekExecutorConfig {
    pub api_key: String,
    pub base_url: String,
}

pub struct DeepSeekRuntimeClient {
    runtime: tokio::runtime::Runtime,
    http: reqwest::Client,
    api_key: String,
    base_url: String,
    model: String,
    enable_tools: bool,
    emit_output: bool,
    allowed_tools: Option<AllowedToolSet>,
    reasoning_cache: std::collections::HashMap<usize, String>,
}

const MAX_REASONING_CHARS_PER_TURN: usize = 32_000;
const MAX_REASONING_CACHE_TOTAL_CHARS: usize = 128_000;

impl DeepSeekRuntimeClient {
    pub fn new(
        config: DeepSeekExecutorConfig,
        model: String,
        enable_tools: bool,
        emit_output: bool,
        allowed_tools: Option<AllowedToolSet>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        Ok(Self {
            runtime: tokio::runtime::Runtime::new()?,
            http: reqwest::Client::builder()
                .user_agent(concat!("aris/", env!("CARGO_PKG_VERSION")))
                .build()?,
            api_key: config.api_key,
            base_url: config.base_url,
            model,
            enable_tools,
            emit_output,
            allowed_tools,
            reasoning_cache: std::collections::HashMap::new(),
        })
    }
}

impl ApiClient for DeepSeekRuntimeClient {
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
        let system_prompt = if request.system_prompt.is_empty() {
            None
        } else {
            Some(request.system_prompt.join("\n\n"))
        };

        let supports_reasoning = supports_reasoning_content_replay(&self.model);
        let messages = convert_messages_deepseek(
            &request.messages,
            system_prompt.as_deref(),
            supports_reasoning,
            &self.reasoning_cache,
        );

        let tools: Option<Value> = self.enable_tools.then(|| {
            let specs = filter_tool_specs(self.allowed_tools.as_ref());
            json!(specs
                .into_iter()
                .map(|spec| convert_tool_spec_deepseek(&spec))
                .collect::<Vec<_>>())
        });

        let mut body = json!({
            "model": self.model,
            "stream": true,
            "stream_options": { "include_usage": true },
            "messages": messages.clone(),  // Clone for debug logging
        });

        eprintln!("\x1b[33mDeepSeek request body: {}\x1b[0m", serde_json::to_string(&body).unwrap_or_default());

        if let Some(tools) = tools {
            body["tools"] = tools;
            body["tool_choice"] = json!("auto");
        }

        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        eprintln!("\x1b[33mDeepSeek URL: {}, API key prefix: {}\x1b[0m", url, &self.api_key[..self.api_key.len().min(8)]);

        self.runtime.block_on(async {
            let send_result = self
                .http
                .post(&url)
                .bearer_auth(&self.api_key)
                .header("content-type", "application/json")
                .json(&body)
                .send()
                .await;
            let mut response = match send_result {
                Ok(resp) => resp,
                Err(e) => return Err(RuntimeError::new(format!("DeepSeek request failed: {e}"))),
            };

            if !response.status().is_success() {
                let status = response.status();
                let body_text = response.text().await.unwrap_or_default();
                return Err(RuntimeError::new(format!(
                    "DeepSeek API error {status}: {body_text}"
                )));
            }

            let mut stdout = io::stdout();
            let mut sink = io::sink();
            let out: &mut dyn Write = if self.emit_output { &mut stdout } else { &mut sink };
            let renderer = TerminalRenderer::new();
            let mut markdown_stream = MarkdownStreamState::default();
            let mut events: Vec<AssistantEvent> = Vec::new();

            let mut current_reasoning = String::new();
            let current_msg_index = request.messages.len();
            let mut pending_tools: Vec<(String, String, String)> = Vec::new();
            let mut stream_buf = String::new();

            loop {
                let chunk_result = response.chunk().await;
                let chunk = match chunk_result {
                    Ok(Some(c)) => c,
                    Ok(None) => break,
                    Err(e) => return Err(RuntimeError::new(format!("Stream error: {e}"))),
                };
                let text = String::from_utf8_lossy(&chunk);
                stream_buf.push_str(&text);

                while let Some(line_end) = stream_buf.find('\n') {
                    let line = stream_buf[..line_end].trim_end_matches('\r').to_string();
                    stream_buf = stream_buf[line_end + 1..].to_string();

                    if line.is_empty() || line.starts_with(':') {
                        continue;
                    }

                    let data = if let Some(d) = line.strip_prefix("data: ") {
                        d.trim()
                    } else {
                        continue;
                    };

                    if data == "[DONE]" {
                        flush_pending_tools(&mut pending_tools, out, &mut events)?;
                        if let Some(rendered) = markdown_stream.flush(&renderer) {
                            write!(out, "{rendered}").and_then(|()| out.flush())
                                .map_err(|e| RuntimeError::new(e.to_string()))?;
                        }
                        events.push(AssistantEvent::MessageStop);
                        break;
                    }

                    let parsed: Value = match serde_json::from_str(data) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };

                    if let Some(usage) = parsed.get("usage") {
                        let input_tokens = usage.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                        let output_tokens = usage.get("completion_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                        events.push(AssistantEvent::Usage(TokenUsage {
                            input_tokens,
                            output_tokens,
                            cache_creation_input_tokens: 0,
                            cache_read_input_tokens: 0,
                        }));
                    }

                    let Some(choices) = parsed.get("choices").and_then(|c| c.as_array()) else {
                        continue;
                    };

                    for choice in choices {
                        let Some(delta) = choice.get("delta") else {
                            continue;
                        };

                        // Capture reasoning_content if supported
                        if supports_reasoning {
                            if let Some(rc) = delta.get("reasoning_content").and_then(|r| r.as_str()) {
                                current_reasoning.push_str(rc);
                            }
                        }

                        // Text content
                        if let Some(content) = delta.get("content").and_then(|c| c.as_str()) {
                            if !content.is_empty() {
                                if let Some(rendered) = markdown_stream.push(&renderer, content) {
                                    write!(out, "{rendered}").and_then(|()| out.flush())
                                        .map_err(|e| RuntimeError::new(e.to_string()))?;
                                }
                                events.push(AssistantEvent::TextDelta(content.to_string()));
                            }
                        }

                        // Tool calls
                        if let Some(tool_calls) = delta.get("tool_calls").and_then(|tc| tc.as_array()) {
                            for tc in tool_calls {
                                let idx = tc.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                                while pending_tools.len() <= idx {
                                    pending_tools.push((String::new(), String::new(), String::new()));
                                }
                                if let Some(id) = tc.get("id").and_then(|i| i.as_str()) {
                                    pending_tools[idx].0 = id.to_string();
                                }
                                if let Some(func) = tc.get("function") {
                                    if let Some(name) = func.get("name").and_then(|n| n.as_str()) {
                                        if !name.is_empty() {
                                            pending_tools[idx].1 = name.to_string();
                                        }
                                    }
                                    if let Some(args) = func.get("arguments").and_then(|a| a.as_str()) {
                                        pending_tools[idx].2.push_str(args);
                                    }
                                }
                            }
                        }

                        if let Some(reason) = choice.get("finish_reason").and_then(|r| r.as_str()) {
                            if reason == "tool_calls" || reason == "stop" {
                                flush_pending_tools(&mut pending_tools, out, &mut events)?;
                            }
                        }
                    }
                }
            }

            // Ensure MessageStop
            if !events.iter().any(|e| matches!(e, AssistantEvent::MessageStop)) {
                for (id, name, input) in pending_tools.drain(..) {
                    if !name.is_empty() {
                        events.push(AssistantEvent::ToolUse { id, name, input });
                    }
                }
                if let Some(rendered) = markdown_stream.flush(&renderer) {
                    write!(out, "{rendered}").and_then(|()| out.flush())
                        .map_err(|e| RuntimeError::new(e.to_string()))?;
                }
                events.push(AssistantEvent::MessageStop);
            }

            // Save reasoning_content for this turn so we can replay it on subsequent calls
            if supports_reasoning && !current_reasoning.is_empty() {
                let mut reasoning = current_reasoning;
                if reasoning.chars().count() > MAX_REASONING_CHARS_PER_TURN {
                    let byte_idx = reasoning
                        .char_indices()
                        .nth(MAX_REASONING_CHARS_PER_TURN)
                        .map(|(i, _)| i)
                        .unwrap_or(reasoning.len());
                    reasoning.truncate(byte_idx);
                }
                self.reasoning_cache.insert(current_msg_index, reasoning);

                // Evict oldest entries if cache exceeds total size cap
                while self
                    .reasoning_cache
                    .values()
                    .map(String::len)
                    .sum::<usize>()
                    > MAX_REASONING_CACHE_TOTAL_CHARS
                {
                    if let Some(oldest_idx) = self.reasoning_cache.keys().copied().min() {
                        if oldest_idx == current_msg_index {
                            break;
                        }
                        self.reasoning_cache.remove(&oldest_idx);
                    } else {
                        break;
                    }
                }
            }

            Ok(events)
        })
    }
}

fn flush_pending_tools(
    pending_tools: &mut Vec<(String, String, String)>,
    out: &mut (impl Write + ?Sized),
    events: &mut Vec<AssistantEvent>,
) -> Result<(), RuntimeError> {
    for (id, name, input) in pending_tools.drain(..) {
        if !name.is_empty() {
            writeln!(out, "\n{}", format_tool_call_start(&name, &input))
                .and_then(|()| out.flush())
                .map_err(|e| RuntimeError::new(e.to_string()))?;
            events.push(AssistantEvent::ToolUse { id, name, input });
        }
    }
    Ok(())
}

fn strip_thinking_tags(input: &str) -> String {
    // DeepSeek-v4-flash emits thinking tags in tool arguments but doesn't accept
    // reasoning_content in requests. Strip the tags to avoid API errors.
    input
        .replace("<think>", "")
        .replace("</think>", "")
}

fn convert_messages_deepseek(
    messages: &[ConversationMessage],
    system_prompt: Option<&str>,
    supports_reasoning_replay: bool,
    reasoning_cache: &std::collections::HashMap<usize, String>,
) -> Vec<Value> {
    let mut result: Vec<Value> = Vec::new();

    if let Some(prompt) = system_prompt {
        result.push(json!({
            "role": "system",
            "content": prompt,
        }));
    }

    for (msg_idx, message) in messages.iter().enumerate() {
        match message.role {
            MessageRole::System => {}
            MessageRole::User => {
                let text = message
                    .blocks
                    .iter()
                    .filter_map(|b| match b {
                        ContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");

                for block in &message.blocks {
                    if let ContentBlock::ToolResult { tool_use_id, output, .. } = block {
                        result.push(json!({
                            "role": "tool",
                            "tool_call_id": tool_use_id,
                            "content": output,
                        }));
                    }
                }

                if !text.is_empty() {
                    result.push(json!({
                        "role": "user",
                        "content": text,
                    }));
                }
            }
            MessageRole::Tool => {
                for block in &message.blocks {
                    if let ContentBlock::ToolResult { tool_use_id, output, .. } = block {
                        result.push(json!({
                            "role": "tool",
                            "tool_call_id": tool_use_id,
                            "content": output,
                        }));
                    }
                }
            }
            MessageRole::Assistant => {
                let mut content_text = String::new();
                let mut tool_calls: Vec<Value> = Vec::new();

                for block in &message.blocks {
                    match block {
                        ContentBlock::Text { text } => {
                            content_text.push_str(text);
                        }
                        ContentBlock::ToolUse { id, name, input } => {
                            tool_calls.push(json!({
                                "id": id,
                                "type": "function",
                                "function": {
                                    "name": name,
                                    "arguments": input,
                                }
                            }));
                        }
                        ContentBlock::ToolResult { .. } => {}
                        ContentBlock::Thinking { .. } => {}
                    }
                }

                let mut msg = json!({ "role": "assistant" });
                if !content_text.is_empty() {
                    msg["content"] = json!(content_text);
                }
                if !tool_calls.is_empty() {
                    msg["tool_calls"] = json!(tool_calls);
                }
                // Attach cached reasoning_content for DeepSeek models that emit it
                if supports_reasoning_replay {
                    if let Some(reasoning) = reasoning_cache.get(&msg_idx) {
                        if !reasoning.is_empty() {
                            msg["reasoning_content"] = json!(reasoning);
                        }
                    }
                }
                result.push(msg);
            }
        }
    }

    result
}

fn convert_tool_spec_deepseek(spec: &ToolSpec) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": spec.name,
            "description": spec.description,
            "parameters": spec.input_schema,
        }
    })
}