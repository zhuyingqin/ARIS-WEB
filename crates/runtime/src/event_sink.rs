//! EventSink trait for passive event logging.
//!
//! The runtime emits events (tool calls, skill invocations, errors) to an
//! injected `EventSink`. The default `NoopEventSink` discards everything.
//! The CLI layer can provide a `JsonlEventSink` that writes to disk.

use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// A single event emitted by the runtime.
#[derive(Debug, Clone)]
pub struct RuntimeEvent {
    pub timestamp: String,
    pub session_id: String,
    pub event_type: EventType,
}

#[derive(Debug, Clone)]
pub enum EventType {
    ToolCall {
        tool_name: String,
        /// Truncated summary of input (never full content)
        input_summary: String,
        is_error: bool,
    },
    SkillInvoke {
        skill_name: String,
        args: String,
    },
    UserPrompt {
        /// Only populated in "content" logging mode; otherwise empty
        preview: String,
        is_slash_command: bool,
    },
    SessionStart {
        model: String,
    },
    SessionEnd,
}

impl fmt::Display for EventType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ToolCall { tool_name, .. } => write!(f, "tool_call:{tool_name}"),
            Self::SkillInvoke { skill_name, .. } => write!(f, "skill_invoke:{skill_name}"),
            Self::UserPrompt { .. } => write!(f, "user_prompt"),
            Self::SessionStart { model } => write!(f, "session_start:{model}"),
            Self::SessionEnd => write!(f, "session_end"),
        }
    }
}

/// Logging detail level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MetaLoggingLevel {
    /// No logging (default).
    #[default]
    Off,
    /// Log event types, tool names, skill names — no prompt content.
    Metadata,
    /// Log event types plus truncated prompt/input previews.
    Content,
}

impl MetaLoggingLevel {
    #[must_use]
    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "metadata" | "meta" => Self::Metadata,
            "content" | "full" => Self::Content,
            _ => Self::Off,
        }
    }
}

/// Trait for receiving runtime events.
pub trait EventSink: Send {
    fn emit(&mut self, event: &RuntimeEvent);
}

/// Discards all events. Zero overhead.
pub struct NoopEventSink;

impl EventSink for NoopEventSink {
    fn emit(&mut self, _event: &RuntimeEvent) {}
}

/// Writes events as JSONL to a file.
pub struct JsonlEventSink {
    path: PathBuf,
    level: MetaLoggingLevel,
    session_id: String,
}

impl JsonlEventSink {
    pub fn new(path: PathBuf, level: MetaLoggingLevel, session_id: String) -> Self {
        Self {
            path,
            level,
            session_id,
        }
    }

    /// Default path: `~/.config/aris/meta/events.jsonl`
    #[must_use]
    pub fn default_path() -> PathBuf {
        let home = crate::home_dir();
        PathBuf::from(home)
            .join(".config")
            .join("aris")
            .join("meta")
            .join("events.jsonl")
    }
}

impl EventSink for JsonlEventSink {
    fn emit(&mut self, event: &RuntimeEvent) {
        if self.level == MetaLoggingLevel::Off {
            return;
        }

        let record = match &event.event_type {
            EventType::ToolCall {
                tool_name,
                input_summary,
                is_error,
            } => {
                let event_name = if *is_error { "tool_failure" } else { "tool_call" };
                let summary = if self.level == MetaLoggingLevel::Content {
                    sanitize_field(input_summary, 200)
                } else {
                    String::new()
                };
                format!(
                    r#"{{"ts":"{}","session":"{}","event":"{}","tool":"{}","input_summary":"{}"}}"#,
                    event.timestamp,
                    escape_json(&sanitize_field(&self.session_id, 60)),
                    event_name,
                    escape_json(&sanitize_field(tool_name, 60)),
                    escape_json(&summary),
                )
            }
            EventType::SkillInvoke { skill_name, args } => {
                let args_field = if self.level == MetaLoggingLevel::Content {
                    sanitize_field(args, 200)
                } else {
                    String::new()
                };
                format!(
                    r#"{{"ts":"{}","session":"{}","event":"skill_invoke","skill":"{}","args":"{}"}}"#,
                    event.timestamp,
                    escape_json(&sanitize_field(&self.session_id, 60)),
                    escape_json(&sanitize_field(skill_name, 60)),
                    escape_json(&args_field),
                )
            }
            EventType::UserPrompt {
                preview,
                is_slash_command,
            } => {
                if *is_slash_command {
                    let cmd = if self.level == MetaLoggingLevel::Content {
                        sanitize_field(preview, 100)
                    } else {
                        // In metadata mode, just record that a slash command was used
                        preview
                            .split_whitespace()
                            .next()
                            .unwrap_or("")
                            .to_string()
                    };
                    format!(
                        r#"{{"ts":"{}","session":"{}","event":"slash_command","command":"{}"}}"#,
                        event.timestamp,
                        escape_json(&sanitize_field(&self.session_id, 60)),
                        escape_json(&cmd),
                    )
                } else if self.level == MetaLoggingLevel::Content {
                    format!(
                        r#"{{"ts":"{}","session":"{}","event":"user_prompt","preview":"{}"}}"#,
                        event.timestamp,
                        escape_json(&sanitize_field(&self.session_id, 60)),
                        escape_json(&sanitize_field(preview, 100)),
                    )
                } else {
                    // Metadata mode: log that a prompt was sent, but not its content
                    format!(
                        r#"{{"ts":"{}","session":"{}","event":"user_prompt"}}"#,
                        event.timestamp, self.session_id,
                    )
                }
            }
            EventType::SessionStart { model } => {
                format!(
                    r#"{{"ts":"{}","session":"{}","event":"session_start","model":"{}"}}"#,
                    event.timestamp,
                    escape_json(&sanitize_field(&self.session_id, 60)),
                    escape_json(&sanitize_field(model, 60)),
                )
            }
            EventType::SessionEnd => {
                format!(
                    r#"{{"ts":"{}","session":"{}","event":"session_end"}}"#,
                    event.timestamp, self.session_id,
                )
            }
        };

        // Best-effort write; never crash the runtime on log failure
        let _ = write_line(&self.path, &record);
    }
}

fn write_line(path: &PathBuf, line: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(file, "{line}")
}

/// Sanitize a string: truncate and remove control chars.
fn sanitize_field(s: &str, max_len: usize) -> String {
    s.chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(max_len)
        .collect::<String>()
        .replace('\n', " ")
}

/// Minimal JSON string escaping.
fn escape_json(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}

/// Current UTC date as `YYYY-MM-DD`. Used to inject the real "today" into
/// system prompts (e.g. `ProjectContext::current_date`) — replacing the
/// previously hard-coded `DEFAULT_DATE` constant that froze on the day the
/// constant was last edited and made models refuse later real-world dates
/// as "future/prompt injection".
#[must_use]
pub fn today_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = secs / 86400;
    let (year, month, day) = days_to_ymd(days);
    format!("{year:04}-{month:02}-{day:02}")
}

/// Generate an ISO 8601 UTC timestamp.
#[must_use]
pub fn now_iso8601() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Simple UTC timestamp without chrono dependency
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;
    // Approximate date calculation (good enough for logging)
    let (year, month, day) = days_to_ymd(days);
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}Z")
}

fn days_to_ymd(days_since_epoch: u64) -> (u64, u64, u64) {
    // Algorithm from http://howardhinnant.github.io/date_algorithms.html
    let z = days_since_epoch + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}
