# Top-10 Substantial-Delta SKILL.md Audit (main vs aris-code bundle)

对比 `main` 分支真源 (`skills/<name>/SKILL.md`) 与 `aris-code` 分支嵌入快照 (`crates/runtime/assets/skills/<name>/SKILL.md`)。每个 skill 总结 main 比 bundle 多出的内容、契约变化、以及对 v0.4.10 binary 用户的实际影响。

---

## paper-writing (+376 lines)

**改动主题**: 增加 submission-gate 全套机制 + style-ref + 多种 illustration backend + kill-argument / citation-audit phase。

**详情**: main 新增三大块: (1) **Phase 0 Assurance Setup** 解析 `— assurance: draft|submission` 或从 `— effort` 派生, 写入 `paper/.aris/assurance.txt`; (2) **Phase 2b Architecture & Illustration** 支持 `illustration: figurespec | gemini | codex-image2 | mermaid | false` 四种生成模式; (3) **Phase 5.6 kill-argument** 对抗 review + **Phase 5.8 citation-audit** + **Phase 6.0 Submission Gate** 调用 `verify_paper_audits.sh` 做外部 verifier 真理源, 不通过则拒绝 Final Report; (4) `— style-ref: <source>` opt-in 调 `tools/extract_paper_style.py`, 仅给 writer-side phase, 严禁泄漏给 reviewer/auditor。引用的 main helper: `verify_paper_audits.sh`, `extract_paper_style.py`, 全部走 canonical strict-safe resolver chain (integration-contract §2).

**对 v0.4.10 binary 用户的影响**: bundle 用户跑 `/paper-writing — effort: beast` 仍只得到旧版 draft 行为, 无 submission gate, 无 verifier 把关, 也无 kill-argument/citation-audit 强制运行。submission-ready 标签从未真实生成。

**Critical**

---

## research-lit (+358 lines)

**改动主题**: 多源检索扩到 9 source + D2 contribution tracking + 所有 helper 走 canonical resolver。

**详情**: main 新增 `gemini` (priority 8) 和 `openalex` (priority 9) 两个 source, 共 9 个 source。**Policy D2 tracking discipline** 要求 orchestrator 跟踪 helper-backed source 是否真的"contributed"(helper 解析成功且 exit 0), 若零 source contribute 则 surface empty-aggregate error。每个 source (arxiv, semantic-scholar, deepxiv, exa, openalex) 都改用 canonical strict-safe resolver, 三层 fallback (`.aris/tools/` → `tools/` → `$ARIS_REPO/tools/`)。引用了 `arxiv_fetch.py`, `semantic_scholar_fetch.py`, `deepxiv_fetch.py`, `exa_search.py`, `openalex_fetch.py`, 全部 warn-and-continue 策略。

**对 v0.4.10 binary 用户的影响**: bundle 用户只有 7 个 source, 看不到 gemini/openalex; helper resolver 是硬编码 `tools/...` 路径, install_aris.sh 后未必能解析, 容易静默失败; D2 empty-aggregate guard 不存在, 可能返回空结果但不报错。

**Critical**

---

## proof-checker (+293 lines)

**改动主题**: `--deep-fix` opt-in 仓库级修复包 + `--restatement-check` opt-in + Submission Artifact Emission (JSON ledger)。

**详情**: main 新增 (1) `--deep-fix` 让 reviewer 同时输出 `deep_fix_plan` (corrected_statement, changed_equations, minimal_tex_patch_plan, closure_tests) 和 `algebra_sanity` (dimension_table, power_count, zero_coupling_check); 严格 opt-in, 默认行为完全不变; (2) `--restatement-check` 检查改后 theorem 与原 statement 是否漂移, 产生 `details.restatement_drift`; (3) 永久写 `PROOF_AUDIT.json` 到 paper 目录, verdict ∈ {PASS, WARN, FAIL, NOT_APPLICABLE, BLOCKED, ERROR}, 含 audited_input_hashes (sha256) 和 thread_id; 无 theorem 也要 emit NOT_APPLICABLE, silent skip 被禁止。Reviewer model 从 `gpt-5.4` 升到 `gpt-5.5`。

**对 v0.4.10 binary 用户的影响**: bundle 用户没有 deep-fix / restatement-check, 没有 JSON artifact, paper-writing Phase 6 verifier 永远 fail (找不到 PROOF_AUDIT.json); reviewer model 仍是旧 5.4。

**Important**

---

## auto-paper-improvement-loop (+171 lines)

**改动主题**: `--style-ref` 和 `--edit-whitelist` 两个 opt-in 参数 + reviewer model 升 5.5。

**详情**: main 新增 (1) `— style-ref: <source>` opt-in, fix-implementation phase 用 `style_profile.md` 做结构 tie-breaker, 但**严禁**传给 reviewer sub-agent (cross-model independence 不变); (2) `— edit-whitelist <path>` 接 YAML/JSON, 含 `allowed_paths`, `forbidden_paths`, `forbidden_operations` (new_cite, new_bibitem, new_theorem_env, numerical_claim), `forbidden_deletions`, `requires_user_approval_for`; 被 `/resubmit-pipeline` Phase 2 用作 text-only 微调护栏; (3) 引用 `extract_paper_style.py` 走 canonical resolver。

**对 v0.4.10 binary 用户的影响**: bundle 用户跑 resubmit pipeline 无 edit-whitelist 保护, 可能改动 .bib / .sty / 添加新 cite 导致违反 venue 规则; 想用 style-ref 也无 helper; reviewer 仍是 5.4。

**Important**

---

## research-wiki (+114 lines)

**改动主题**: 新增 `sync` 子命令 + 强制 canonical `$WIKI_SCRIPT` resolver + 区分 hard-fail vs warn-and-skip caller。

**详情**: main 把 `tools/research_wiki.py` 包装成 canonical `$WIKI_SCRIPT` resolver chain, **强制**所有调用方走该 chain ("never hard-code `python3 tools/research_wiki.py …`")。`/research-wiki` 本身 hard-fail; 作为副作用调用的 skill (`/idea-creator`, `/result-to-claim`, `/research-lit`, `/arxiv`, `/alphaxiv`, `/deepxiv`, `/semantic-scholar`, `/exa-search`) warn-and-skip, 不阻塞主输出。引用真实事故: 安装后 `tools/` 不存在导致 wiki 空了一周。

**对 v0.4.10 binary 用户的影响**: bundle 版直接 hard-code `tools/research_wiki.py`, 在 `install_aris.sh` 后 (`tools/` 不在用户项目里) 全部静默失败, 这就是真实 user 一周空 wiki 的根因 —— v0.4.10 binary 用户仍会遇到这个 bug。

**Critical**

---

## paper-plan (+92 lines)

**改动主题**: `--style-ref` opt-in + `GAP_REPORT.md` 自动生成 + reviewer 升 5.5。

**详情**: main 加 `— style-ref: <source>` opt-in, helper resolve 走 canonical chain; 当 style-ref 成功且项目有 `figures/`、`results/`、`NARRATIVE_REPORT.md` 等时, **额外**生成 `GAP_REPORT.md`, 把 exemplar 的 section topology 与用户 asset 对照, 每个 slot 标 `covered` / `partial` / `missing`, 用于 `/paper-write` 决定何时插入 `<!-- DATA_NEEDED -->` placeholder。Reviewer model 从 `gpt-5.4` 升 `gpt-5.5`。

**对 v0.4.10 binary 用户的影响**: bundle 用户传 style-ref 会被忽略 (parser 不识别 / helper 找不到), 也不会拿到 GAP_REPORT.md, 后续 paper-write 无 DATA_NEEDED 数据空缺信号, 容易杜撰内容。

**Important**

---

## paper-claim-audit (+82 lines)

**改动主题**: Submission Artifact Emission + review tracing + path-key normalization。

**详情**: main 强制**总是**写 `paper/PAPER_CLAIM_AUDIT.json`, 含 verdict ∈ {PASS, WARN, FAIL, NOT_APPLICABLE, BLOCKED, ERROR} (NOT_APPLICABLE = 论文无 numeric claim; BLOCKED = 有 numeric claim 但找不到 raw result), `reason_code`, `audited_input_hashes` (sha256), `trace_path`, `thread_id`。新增 **Review Tracing** section, 调 `save_trace.sh` 把每次 codex MCP 调用保存到 `.aris/traces/<skill>/<date>_run<NN>/` (Policy C — forensic, 不可 silent skip)。Path key 区分: `audited_input_hashes` 用相对 paper-dir 路径 (无 `paper/` 前缀)。Reviewer model 升 `gpt-5.5`。

**对 v0.4.10 binary 用户的影响**: bundle 无 JSON artifact / 无 verdict ledger, `paper-writing` Phase 6 verifier 找不到这个文件就 fail; 也无 trace 留档, 出问题没法复现。

**Important**

---

## paper-write (+62 lines)

**改动主题**: `--style-ref` opt-in + `<!-- DATA_NEEDED -->` marker 集成 + reviewer 升 5.5。

**详情**: main 加 `— style-ref: <source>` opt-in 走 canonical resolver; 当 `paper-plan` 跑了 style-ref 并产生 `GAP_REPORT.md` 时, paper-write 遇到 `status: missing` 的 slot **不允许杜撰**, 必须 emit `<!-- DATA_NEEDED: GAP_S5_ABLATION — ablation table ... -->` HTML 注释 (PDF 中不可见, grep 可搜)。明确把这个 marker 作为"no placeholder"规则的合法 carve-out。Reviewer model 升 `gpt-5.5`。

**对 v0.4.10 binary 用户的影响**: bundle 用户即便 paper-plan 产生 GAP_REPORT, paper-write 也不识别, 仍会按旧规则杜撰内容填满 ablation 等空 slot, 留下 hallucinated number。

**Nice-to-have** (因 style-ref 本身是 opt-in)

---

## paper-slides (+61 lines)

**改动主题**: `--style-ref` opt-in + reviewer 升 5.5。

**详情**: main 加 `— style-ref: <source>` opt-in, talk 的 section budget / theorem density 可以匹配 exemplar; helper 走 canonical resolver; 严格不传给 reviewer sub-agent; talk-type slide count 仍优先 (style-ref 不能压过 spotlight=8-12 这种硬约束)。Reviewer 从 `gpt-5.4` 升 `gpt-5.5`。其他大部分内容文档级措辞调整 (style guidance, content discipline)。

**对 v0.4.10 binary 用户的影响**: 影响最小, style-ref opt-in 用户感知不到差异, 唯一是 reviewer 仍调旧模型。

**Nice-to-have**

---

## exa-search (+50 lines)

**改动主题**: helper 从硬编码 `tools/exa_search.py` 升级为 canonical strict-safe resolver chain。

**详情**: main 把 `FETCH_SCRIPT = tools/exa_search.py` 改为 `EXA_FETCHER` canonical name + Policy D1 cascade (没有 inline fallback, helper 缺失即 hard-fail 并给出 install_aris.sh / ARIS_REPO / cp 三种修复方案)。Resolver 检 `.aris/tools/` → `tools/` → `$ARIS_REPO/tools/`。文档解释了为何 standalone /exa-search 不能 warn-skip (retrieval 强依赖 exa-py SDK + API key, 必须经 helper)。

**对 v0.4.10 binary 用户的影响**: bundle 用户的 skill 硬编码 `tools/exa_search.py`, 不在用户项目里就静默 404; main 版本会清楚提示如何修。这是 D1 helper 问题在 search source 上的具体表现。

**Critical** (因为 user-facing search 失败但无报错)

---

## 总览发现

主要 cross-skill 模式: (1) **canonical resolver chain** (integration-contract §2) 普遍替代硬编码 `tools/` 路径, 这是 v0.4.10 install_aris.sh + .aris/tools symlink 配套设施的契约级要求; (2) **Submission Artifact Emission** 在三大 audit (proof-checker / paper-claim-audit / citation-audit) 全面铺开, 由 `verify_paper_audits.sh` 当真理源; (3) **opt-in 参数**(`--style-ref`, `--deep-fix`, `--edit-whitelist`, `--restatement-check`, `--assurance`) 全部默认 OFF, 不影响旧调用; (4) reviewer model 从 `gpt-5.4` 普遍升 `gpt-5.5` (Codex MCP 服务端 5.5+xhigh 已开闸)。

v0.4.10 binary 用户最关键的缺失是 **helper resolver chain** —— 多 skill 仍指向 `tools/` 硬路径, install 后即无法解析, 形成"看起来在跑 ARIS 但所有 helper 静默失败"的影子失败模式 (research-wiki 空一周事故是已知案例)。建议 v0.4.11 优先回填 canonical resolver, 其次 reviewer model 统一升 5.5, 第三再考虑 opt-in 新功能。
