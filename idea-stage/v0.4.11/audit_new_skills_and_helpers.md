# v0.4.11 Audit: main-only skills & tools helpers

Scope: 10 skills present on `origin/main` but absent from the v0.4.10 binary bundle, plus the 23 `tools/` helpers that exist on `main` but not in `crates/runtime/assets/tools/`. Audit performed against `origin/main` (fetched 2026-05-17). Branch on disk: `aris-code` (unchanged).

---

## Part A — 10 main-only skills

### 1. citation-audit (self-contained)

- **作用**: 零上下文跨模型审计每条 `\cite{...}` 的存在性 / 元数据 / 上下文恰当性，捕捉 wrong-context、author hallucination、phantom DOI 等"危险但表面合理"的引用错误。Triggers: "审查引用"/"check citations"/"verify references"。argument-hint `[paper-dir] [--uncited] [— soft-only]`。
- **依赖**: SKILL.md 引用 `shared-references/{review-tracing,integration-contract,reviewer-independence,citation-discipline,assurance-contract}.md`、helper `save_trace.sh`、外部脚本 `verify_paper_audits.sh`；互引 `/paper-claim-audit`、`/result-to-claim`、`/experiment-audit`，并被 `/resubmit-pipeline` Phase 1 以 `— soft-only` 模式调用。reviewer = `mcp__codex__codex` gpt-5.5 xhigh，WEB_SEARCH 必需。
- **关键 contracts**: 写 `CITATION_AUDIT.md` + `CITATION_AUDIT.json`，按 `.aris/traces/citation-audit/<date>_run<NN>/` 落 per-entry trace；assurance schema 必须满足 `shared-references/assurance-contract.md` —— **`tools/verify_paper_audits.sh` 把 `CITATION_AUDIT.json|citation-audit` 列入 MANDATORY_AUDITS**（line 39）。"Always emit, never block" —— gate 由 `paper-writing` Phase 6 + verifier 决定。
- **嵌入复杂度**: self-contained，目录下仅 1 个 SKILL.md。无 scripts/。运行期依赖 main 才有的 `save_trace.sh`（aris-code 已 bundle）与 `verify_paper_audits.sh`（aris-code 已 bundle）。**不嵌入此 skill 会使 `verify_paper_audits.sh` 在 paper-writing assurance=submission 时硬卡 BLOCKED**——一切 paper-writing 提交流水都会停。

### 2. experiment-queue (HAS scripts/)

- **作用**: SSH GPU 服务器上的多 seed/grid 实验任务队列，处理 OOM 重试 / 卡死 screen 清理 / wave 转换竞争 / teacher→student 链式。Triggers: "batch experiments"/"队列实验"/"run grid"。≥10 个 job 时取代 `/run-experiment`。
- **依赖**: `Skill(run-experiment)`、`Skill(monitor-experiment)`、helper `scripts/queue_manager.py`（canonical, Phase 3.3 移入 skill 自带 scripts/）+ `scripts/build_manifest.py`；legacy 兼容层 `tools/experiment_queue/{queue_manager,build_manifest}.py` 是 `os.execv` shim。解析链 `CLAUDE_SKILL_DIR/scripts/` → `.aris/tools/` → `tools/` → `$ARIS_REPO/tools/`。
- **关键 contracts**: 输出 `queue_state.json` + `summary.md` + per-job logs；远端 scheduler 退出 `All jobs done` 后由本地 agent 聚合。无 trace 文件；非 assurance gate。
- **嵌入复杂度**: **必须嵌入 SKILL.md + scripts/ 整目录**（`queue_manager.py` 是 scheduler 实现本身，不是辅助）。tools/experiment_queue/ 即便嵌入也只是 shim 转发到 skill 内 scripts/。**只 bundle SKILL.md 而漏 scripts/，所有 batch 实验会 ERROR: experiment_queue helpers not found**。

### 3. gemini-search (self-contained)

- **作用**: 通过 Gemini MCP / CLI 做 AI-powered 文献广撒网搜索；与 `/arxiv`、`/semantic-scholar`、`/openalex`、`/exa-search`、`/deepxiv` 互补，主打"分解主题为子问题、追踪命名变体"。Triggers: "gemini search"/"search with gemini"。
- **依赖**: 仅依赖 `mcp__gemini-cli__*` MCP tools（无 fallback CLI 调用助手脚本）。SKILL.md 不引用任何 `tools/` 或 `scripts/`，不引用 shared-references。互引 `/research-lit`、`/semantic-scholar`、`/arxiv` 作为兜底建议。模型默认 `gemini-3-pro-preview`，亦支持 `auto-gemini-3`。
- **关键 contracts**: 输出按 markdown 表格列 paper（无 trace、无 assurance gate）。纯发现性 skill。
- **嵌入复杂度**: 纯 SKILL.md，零外部 helper 依赖。**只要 user 端 Gemini MCP 已配，bundle 进去立刻可用**。

### 4. kill-argument (self-contained)

- **作用**: 两线程对抗 review —— 第一个 fresh Codex 写 ≤200 词的最强 rejection memo，第二个 fresh Codex 拆成 3-7 个 rejection points 并逐点判定 `answered_by_current_text / partially_answered / still_unresolved`。Triggers: "kill argument"/"adversarial review"/"hostile review"/"reviewer-2 simulation"。
- **依赖**: `mcp__codex__codex`（永远 fresh，**never** codex-reply）；`shared-references/{reviewer-independence,review-tracing,integration-contract,assurance-contract,experiment-integrity}.md`；helper `save_trace.sh`；和 `/peer-review`、`/proof-checker`、`/paper-claim-audit`、`/citation-audit`、`/auto-paper-improvement-loop` 互补；被 `/resubmit-pipeline` Phase 3 调用为强制 gate。
- **关键 contracts**: 写 `KILL_ARGUMENT.md` + `KILL_ARGUMENT.json`，trace 落 `.aris/traces/kill-argument/<date>_run<NN>/`，**两个 thread 的 raw response 都要保留**。`tools/verify_paper_audits.sh` 把 `KILL_ARGUMENT.json|kill-argument` 列入 MANDATORY_AUDITS（line 40）。
- **嵌入复杂度**: self-contained，仅 1 个 SKILL.md。**与 citation-audit 同等关键**：不嵌入会让 `verify_paper_audits.sh` 在 submission 路径硬卡——即 paper-writing assurance=submission / resubmit-pipeline Phase 3 都过不去。

### 5. openalex (self-contained，但依赖 tools helper)

- **作用**: 通过 OpenAlex API 检索学术论文，强项是开放引文图 + institutional affiliations + funding info + 250M+ works 跨库覆盖。Triggers: "openalex search"/"search openalex"/"open citation graph"。
- **依赖**: helper `tools/openalex_fetch.py`（OPENALEX_FETCHER constant，按 Policy D1 解析 `.aris/tools/` → `tools/` → `$ARIS_REPO/tools/`，无 inline fallback —— 解析失败直接 exit 1）。无 shared-references 业务依赖。和 `/research-lit` 互引。
- **关键 contracts**: 输出 markdown paper list；无 trace、无 assurance gate。
- **嵌入复杂度**: SKILL.md self-contained，**但 helper `openalex_fetch.py` 已经 bundle 在 aris-code（位于 `crates/runtime/assets/tools/openalex_fetch.py`）**。所以只要把 SKILL.md 嵌入即可，helper 不会缺。

### 6. overleaf-sync (self-contained，但依赖 2 个 shell helper)

- **作用**: 本地 paper 目录与 Overleaf 项目通过 Git bridge 双向同步（Premium feature），token 走 macOS Keychain，agent 从不接触 token。Triggers: "同步 overleaf"/"overleaf sync"/"推送到 overleaf"/"Overleaf 桥接"。子命令 `setup <id> | pull | push | status`。
- **依赖**: helper `tools/overleaf_setup.sh`（一次性 TTY-only 设置 + 安装 pre-commit token 阻止钩子）、`tools/overleaf_audit.sh`（漂移诊断）。两者都被 SKILL.md 显式调用 (`bash <ARIS_REPO>/tools/overleaf_*.sh`)。互引 `/paper-claim-audit`、`/citation-audit`、`/auto-paper-improvement-loop`；被 `/resubmit-pipeline` Phase 4 调用。
- **关键 contracts**: 用 git 自身的 fast-forward / rsync 做单一可信源切换；**`push` 有强制 confirmation gate**（写共享资源）。`overleaf_audit.sh` 是 Policy E 诊断器（不阻塞）。
- **嵌入复杂度**: SKILL.md self-contained，**但运行时硬依赖 main `tools/overleaf_setup.sh` + `tools/overleaf_audit.sh` 这两个 shell helper**，并且 SKILL.md 里 setup 步骤明确告诉用户 `bash <ARIS_REPO>/tools/overleaf_setup.sh <project-id>`。不 bundle 这两个 helper，`/overleaf-sync setup` 会失败，所有 `/resubmit-pipeline` Phase 4 push 流程也跟着失败。

### 7. paper-talk (self-contained orchestrator)

- **作用**: End-to-end conference talk pipeline —— paper → SLIDE_OUTLINE.md → Beamer + PPTX → per-page polish → claim/citation/anonymity audits → final report。Triggers: "做 talk"/"做 PPT 全流程"/"conference talk full workflow"。`— assurance: draft|polished|conference-ready` 三档。
- **依赖**: 纯 orchestrator —— 委托 `/paper-slides`、`/slides-polish`、`/paper-claim-audit`、`/citation-audit`；用 `mcp__codex__codex` 仅在 anonymity scan / fix proposal review 时；引用 `shared-references/{reviewer-independence,experiment-integrity,assurance-contract}.md`。无直接 `tools/` 依赖。
- **关键 contracts**: 输出 `slides/{SLIDE_OUTLINE.md, main.tex, main.pdf, presentation.pptx, presentation_pre_polish.pptx, presentation_polished.pptx, speaker_notes.md, TALK_SCRIPT.md}` + state in `.aris/paper-talk/`；assurance=conference-ready 时强制跑 Phase 4 claim+citation+anonymity audit，PHASE 4 失败则 final report 不能标 `conference-ready`。
- **嵌入复杂度**: SKILL.md self-contained（381 行）。**但传递依赖巨大**：需要 `/paper-slides`、`/slides-polish`、`/paper-claim-audit`、`/citation-audit` 全部 bundle 在内才能跑 polished/conference-ready；assurance=draft 可不需要 slides-polish 和 audit skills。

### 8. qzcli (self-contained)

- **作用**: 启智 (Qizhi) 平台 GPU 任务管理 CLI 的 skill 包装，kubectl 风格命令 `login/avail/list/create/stop/batch/status/watch`。Triggers: "qzcli"/"启智平台"/"submit job"/"查计算组"/"avail"。
- **依赖**: 完全外部 ——`pip install qzcli` + 可选 MCP server。SKILL.md 不引用任何 `tools/`、`scripts/`、`shared-references/`、其他 skill。配置文件 `~/.qzcli/{config.json,.cookie,resources.json,jobs.json}` + 可选 `.env`。
- **关键 contracts**: 无 trace、无 assurance gate、无 audit output。CLI 命令直接打 stdout。
- **嵌入复杂度**: 完全 self-contained，零依赖。bundle SKILL.md 即可用（前提是用户已 `pip install qzcli`）。这是 10 个 skill 里嵌入风险最低的一个。

### 9. resubmit-pipeline (self-contained orchestrator)

- **作用**: Workflow 5 —— 把已打磨好的论文以 text-only 方式（不跑新实验、不动 bib、不改框架、never overwrite 旧 venue 目录）移植到新会议。Triggers: "resubmit pipeline"/"重投流程"/"port paper to <venue>"。Phase 0 物理隔离 → 0.5 健康+匿名 → 1 audit → 2 microedit auto-loop → 3 kill-argument gate → 4 final compile + overleaf push。
- **依赖**: orchestrator —— 委托 `/proof-checker`、`/paper-claim-audit`、`/citation-audit --soft-only`、`/auto-paper-improvement-loop`、`/kill-argument`、`/paper-compile`、`/overleaf-sync`；reviewer 用 `mcp__codex__codex` (gpt-5.5 xhigh)；引用 `shared-references/{assurance-contract,review-tracing}.md`、外部脚本 `verify_paper_audits.sh`。
- **关键 contracts**: 写 `<NewVenue>/RESUBMIT_REPORT.json` + `.aris/traces/<phase>/<date>_run<NN>/`；assurance schema 同 paper-writing；**Phase 3 `/kill-argument` FAIL 阻塞 final report**；Phase 2 用 `<paper-base>/../<NewVenue>/.aris/edit_whitelist.yaml` 限制可编辑面；NEVER_OVERWRITE = true 是硬不变量。
- **嵌入复杂度**: SKILL.md self-contained，**但传递依赖巨大**：proof-checker、paper-claim-audit、citation-audit、auto-paper-improvement-loop、kill-argument、paper-compile、overleaf-sync 全部要 bundle 才能跑全流程；其中 kill-argument 和 citation-audit 还是 mandatory audit gate。

### 10. slides-polish (self-contained)

- **作用**: PPTX/Beamer 现有 slides 的 per-page Codex review + 针对性修补 —— 视觉权重对齐 reference PDF、PPTX 字号提升 1.5-1.8×、italic style leak 消除、text-frame 溢出修复、anonymity placeholder 检查。Triggers: "polish slides"/"slides 排版不对"/"PPTX 字体太小"/"per-page review"。**只动排版不动内容**。
- **依赖**: `mcp__codex__codex` fresh per page（NEVER codex-reply）；外部 `python-pptx>=0.6`、`pdfinfo`+`pdftoppm`/`mutool draw`、`soffice`、xelatex/pdflatex+latexmk；引用 `shared-references/{effort-contract,reviewer-independence,review-tracing,experiment-integrity}.md`。被 `/paper-talk` 调用。SKILL.md 不调任何 `tools/` 脚本。
- **关键 contracts**: 输出版本化 `<stem>_polished.pptx/_polished.tex`（原文件 NEVER overwrite，保留 `_pre_polish` snapshot），trace 落 `.aris/slides-polish/<stem>/traces/slide_KK.json` + 通用 `.aris/traces/slides-polish/<date>_runNN/`。anonymity fix-proposal 触发 BLOCKED verdict 等人审。非 verify_paper_audits.sh 强制 audit。
- **嵌入复杂度**: SKILL.md self-contained（500+ 行，含 Style Presets 和 Effort 矩阵）。零脚本依赖。bundle SKILL.md 即可，前提是用户机器装好 python-pptx + poppler + LibreOffice。

---

## Part B — 23 main-only `tools/` helpers

格式：`helper` — 用途；Used by。

### Runtime helpers（必须 bundle 才能让对应 skill 工作）

1. **extract_paper_style.py** — 从 reference PDF/tex 提取风格指纹（章节结构、断句、动词偏好等）供 paper 系列 skill 做 style transfer。Used by: **paper-write, paper-plan, paper-slides, paper-poster, paper-illustration, grant-proposal, auto-paper-improvement-loop, paper-writing** (≥7 skills，Policy A 当 `— style-ref:` 触发；不 bundle 用户传 style-ref 时 skill ERROR exit 1)。
2. **figure_renderer.py** — Phase 3.1 后是 `os.execv` shim → `skills/figure-spec/scripts/figure_renderer.py`。Used by: **figure-spec** (shim 仅给 legacy resolver 走；canonical 在 skill 自带 scripts/。aris-code 嵌入 figure-spec/scripts/ 即可，shim 可丢)。
3. **paper_illustration_image2.py** — Phase 3.2 后是 `os.execv` shim → `skills/paper-illustration-image2/scripts/paper_illustration_image2.py`。Used by: **paper-illustration-image2, paper-writing**（同 figure_renderer，canonical 已迁入 skill 内）。
4. **experiment_queue/queue_manager.py** — Phase 3.3 后是 shim → `skills/experiment-queue/scripts/queue_manager.py`。Used by: **experiment-queue**（canonical 在 skill 内）。
5. **experiment_queue/build_manifest.py** — Phase 3.3 后是 shim → `skills/experiment-queue/scripts/build_manifest.py`。Used by: **experiment-queue**（同上）。
6. **experiment_queue/README.md** — 给手动 ssh 安装的 user-facing 文档；non-runtime。Used by: **experiment-queue**（文档；不嵌入不影响运行）。
7. **overleaf_setup.sh** — Overleaf Git bridge 一次性 TTY 设置（hidden read token + osxkeychain + pre-commit hook）。Used by: **overleaf-sync** (Policy A skill-blocking — 不 bundle 则 `/overleaf-sync setup` 直接报缺脚本)。
8. **overleaf_audit.sh** — Overleaf 项目漂移诊断（Policy E）。Used by: **overleaf-sync** (诊断器，缺则跳过但不阻塞)。
9. **verify_wiki_coverage.sh** — research-wiki 覆盖率诊断脚本（Policy E）。Used by: **research-wiki** (诊断器；缺则 warn 但不阻塞)。
10. **watchdog.py** — 远端 GPU 进程健康监控（独立于 training-check 的质量监控）。Used by: **training-check** (作为参考脚本被 SKILL.md 引用解释定位差异；non-blocking)。
11. **meta_opt/log_event.sh** — Claude Code hooks 在 SessionEnd 时被动记录 skill 调用次数。Used by: **meta-optimize** (hook 端必备；不嵌入则 skill 调用计数器失效)。
12. **meta_opt/check_ready.sh** — SessionEnd hook 自动判断"是否到 5 次该跑 meta-optimize 了"。Used by: **meta-optimize** (同上；hook-runtime helper)。

### Install-time / 维护工具（installer-only，bundle 进 binary 没意义）

13. **install_aris.sh** — POSIX shell 安装器：clone repo → 安装 hooks → 建 `.aris/tools` symlink → 配置 settings。installer-only。
14. **install_aris.ps1** — Windows PowerShell 等价 installer。installer-only。
15. **install_aris_codex.sh** — Codex CLI variant 的安装器（注入 Codex MCP review override 的 SKILL.md）。installer-only。
16. **install_aris_copilot.sh** — GitHub Copilot CLI variant 的安装器。installer-only。
17. **smart_update.sh** — 智能 skill 更新（检测个人信息、安全替换、3-way merge）。installer-only。
18. **smart_update.ps1** — Windows 等价。installer-only。
19. **smart_update_codex.sh** — Codex variant 智能更新。installer-only。
20. **smart_update_copilot.sh** — Copilot variant 智能更新。installer-only。
21. **lint_skills_helpers.sh** — CI 工具（被 `.github/workflows/lint-skills-helpers.yml` 调用）：在 dev 时检查 SKILL.md 是否引用了不存在的 helper。CI/dev-only，非 runtime。
22. **convert_skills_to_llm_chat.py** — 离线生成器：把 SKILL.md 转成 LLM-friendly chat format（用于发布到 OpenWebUI 等）。installer/dev-only。
23. **generate_codex_claude_review_overrides.py** — 离线生成器：基于通用 SKILL.md 生成 Codex 变体 (`skills-codex/`)。dev-only（产物已 checked in，runtime 不需要再跑）。

---

## 关键发现 (assurance-critical, missing 会静默 fail)

1. **citation-audit + kill-argument 是 verify_paper_audits.sh 强制 audit**（main `tools/verify_paper_audits.sh` line 36-40 MANDATORY_AUDITS）。两个 skill 不 bundle 进 v0.4.10 binary，**任何 paper-writing assurance=submission 或 resubmit-pipeline Phase 3 都会硬卡 BLOCKED**，但 verify 脚本本身仍可运行（脚本已在 aris-code bundle），只是它会要求两个 audit JSON 而 skill 不存在 → user 体验是"`/paper-writing` 跑到 Phase 6 突然报缺 audit，但找不到 audit skill"。
2. **experiment-queue scripts/ 是实现本体不是辅助**：canonical `queue_manager.py` 已从 `tools/` 搬到 `skills/experiment-queue/scripts/`（Phase 3.3）。只 bundle SKILL.md 而漏 `scripts/` 子目录，所有 `/experiment-queue` 调用会报 `ERROR: experiment_queue helpers not found`。同样 figure-spec 和 paper-illustration-image2 在 Phase 3.1/3.2 后也是 canonical 在 `skills/.../scripts/`。
3. **overleaf-sync 强依赖 2 个 shell helper**：`overleaf_setup.sh`（Policy A skill-blocking）和 `overleaf_audit.sh`（Policy E 诊断）。前者不 bundle 则 setup 子命令直接死；resubmit-pipeline Phase 4 push 链跟着死。
4. **extract_paper_style.py 是 7 个 paper 系列 skill 的共享 helper**：activation predicate 是 `— style-ref:` 参数。不 bundle 时大多数 paper 流程仍能跑（不传 style-ref 即可），但任何用户加 `— style-ref:` 都会 ERROR exit 1。
5. **paper-talk / resubmit-pipeline 传递依赖最重**：两者本身 self-contained，但分别需要 4 个 / 7 个其他 skill 全部 bundle 才能完整跑通；slides-polish + kill-argument + citation-audit 缺任何一个都会半路死。
6. **gemini-search / qzcli / openalex / slides-polish / paper-talk 这 5 个 SKILL.md self-contained 零脚本依赖**，是最低风险的嵌入。其中 openalex 的 helper `openalex_fetch.py` 已在 aris-code bundle，可立即生效。
7. **Installer/dev-only 工具（13-23 共 11 个）不应进 binary**：`install_aris*.{sh,ps1}` / `smart_update*.{sh,ps1}` / `lint_skills_helpers.sh` / `convert_skills_to_llm_chat.py` / `generate_codex_claude_review_overrides.py` 是发布到 ARIS repo + ship binary 的辅助工具，应保留在 main `tools/` 而不进 `crates/runtime/assets/tools/`。
8. **meta_opt 两脚本属于 Claude Code SessionEnd hook 端**：log_event.sh / check_ready.sh 由 settings.json hook 触发，不在 skill 调用栈内。这俩要么 install_aris.sh 装到本地 hook 配置里，要么 binary 在初始化时直接拷贝到 `~/.claude/hooks/` —— 不属于"按需提取"的 helper 类别。
