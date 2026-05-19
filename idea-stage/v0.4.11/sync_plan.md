# v0.4.11 Skills Sync 方案设计 (Stage 2 — v2 post-codex round-1)

> **v2 变更**: 按 codex round-1 8 个 finding 修订:
> - Gemini sed 改成 contextual review，排除 `paper-illustration/SKILL.md` 的 `generativelanguage.googleapis.com` REST URL
> - build.rs warning 预期数字校正: **74 skills (不是 78)** + **~51 helpers (不是 46)**，因为 build.rs 排除 `skills-codex*` 且 shared-references 算 helpers
> - `SKILLS_SOURCE_COMMIT` test 加强：CI fetch + 比对 `origin/main` 一致性，不只是检查文件存在
> - rsync symlink 防护：删掉无效的 `--copy-links=NO`，改用 `find -type l` 前置检测
> - **skills-codex/ 完全不进 binary**（build.rs 已 exclude，不要白嵌入）
> - **meta_opt/ hook 不进 v0.4.11**（hook init copy 机制推 v0.4.12）→ runtime helper 白名单从 11 降到 9
> - helper reference test 用 allowlist + denylist 分类
> - 分级调整: extract_paper_style.py + overleaf_setup.sh 从 Critical 降到 Important（opt-in 路径）



## Audit 数据来源
- `audit_top10_changed_skills.md` — 10 个大改 SKILL.md 主题摘要
- `audit_new_skills_and_helpers.md` — 10 个 new skill + 23 个 main-only helper 分类
- Agent 3 build.rs report — WalkDir 递归已支持 Phase 3 Arch C 嵌套，无需改 build.rs
- 现场 audit:
  - **skill 总数 diff**: main 78 / aris-code bundle 68（缺 10）
  - **46/68 共有 SKILL.md 内容不一致**
  - **skills-codex/ 镜像**: main 117 / bundle 73（缺 44 个文件，Codex agent 用的 skill mirror）
  - **shared-references/**: main 19 / bundle 17，5 个共有文件全变；缺 `assurance-contract.md` + `wiki-helper-resolution.md`
  - **tools/**: main 32 / bundle 9，差 23 个 helper。v0.4.11 **sync 完整 18 个 runtime helper**：(a) 现有 9 个 baseline (arxiv_fetch.py / deepxiv_fetch.py / exa_search.py / openalex_fetch.py / research_wiki.py / save_trace.sh / semantic_scholar_fetch.py / verify_paper_audits.sh / verify_papers.py) **必须从 main 刷新**（codex round-3 #1 发现 `research_wiki.py` 在 main 已从 315→767 行，含 canonical `ingest_paper` API；不刷新就 SKILL.md 引用新 API 但 binary 是旧版）+ (b) 新增 9 个 (extract_paper_style.py / figure_renderer.py / paper_illustration_image2.py / overleaf_setup.sh / overleaf_audit.sh / verify_wiki_coverage.sh / watchdog.py / experiment_queue/build_manifest.py / experiment_queue/queue_manager.py)。**不 bundle**: meta_opt 2 个（推 v0.4.12）+ experiment_queue/README.md（doc）+ 留 main 的 11 个 installer/dev 工具

## 重要事实校正（user / codex 早期沟通中的误解）

**`d43d77a` (5月13日) 改 reviewer 默认 gpt-5.4 → gpt-5.5 是文档同步，不是 CLI 行为改动**。
- aris-code 分支 `crates/tools/src/lib.rs:3421` 早在 v0.4.5 (`87e1088`) 就把 CLI 默认 reviewer 改成 `gpt-5.5`
- `crates/aris-cli/src/config.rs:304/348/545/572` 的 setup 菜单 OpenAI 默认也是 5.5
- **CLI 实际行为一直是 5.5**；main d43d77a 只是把 skills 文档里的 `REVIEWER_MODEL = gpt-5.X` 例子从过时的 5.4 改成跟 CLI 一致的 5.5
- 因此**不需要 revert** d43d77a 的 sed —— 不 revert 反而让 binary 内置文档跟 CLI 实际行为对齐
- 用户原意是"不想再折腾接口"，跟 reviewer model 文档无关

## Sync 总体策略

**方案 A（codex 推荐 + 我同意）**: full skills/resources sync + sync script + CI drift check + Gemini alias hotfix。

把这次 sync 当作 v0.4.11 的核心 release scope，原来 v0.4.10 codex audit 的 4 个 P1 (Anthropic retry / o-series reasoning / stream_options proxy fallback / per-server MCP timeout) 全部推到 v0.4.12，因为：
1. user-impact 远小于 skill 缺失（这些 P1 都是 polish + 边缘 case）
2. skills sync 改动范围大，混编 API behavior 改动会让 review 变模糊
3. 一旦 release 节奏稳定，v0.4.12 把 4 P1 一起做相对安全

## 具体步骤

### Step 1 — 写 `tools/sync_main_skills.sh`（自动化 sync 入口）

脚本职责：
1. 检查工作目录干净（无 uncommitted changes，未 staged 修改）
2. `git fetch origin main`，读 `origin/main` 的 commit SHA 留作 `MAIN_SHA`
3. 用 `git worktree add /tmp/aris-main origin/main` 拉出 main 的完整 working tree
4. **Symlink 前置检测（critical, codex round-1 #4）**：
   ```
   if find /tmp/aris-main/skills/ /tmp/aris-main/tools/ -type l | head -1 | grep -q .; then
     echo "ERROR: symlinks detected in main snapshot, abort"
     find /tmp/aris-main/skills/ /tmp/aris-main/tools/ -type l
     exit 1
   fi
   ```
   `rsync -a` 默认 preserve symlink；遇到 symlink build.rs 会 panic。前置检测比依赖 rsync flag 安全。
5. **Skills full rsync (排除 skills-codex 全部 variant)**：
   ```
   REPO_ROOT=$(git rev-parse --show-toplevel)
   rsync -av --delete \
     --exclude='*.pyc' --exclude='__pycache__/' --exclude='.DS_Store' \
     --exclude='skills-codex*/' \
     /tmp/aris-main/skills/ \
     "$REPO_ROOT/crates/runtime/assets/skills/"
   ```
   - `--delete` 让 aris-code 跟 main 完全对齐（删掉 aris-code 多出来但 main 没有的旧 skill）
   - `skills-codex*/` glob 覆盖 `skills-codex/`、`skills-codex-foo/`、`skills-codexfoo/` 所有 variant
   - **skills-codex/ 不进 binary** — build.rs 在 line 12 用 exact allow/exclude list（不是 glob，所以 rsync 多加防御），prompt.rs 只渲染 BUNDLED_SKILLS（codex round-1 #5）
   - **建议 follow-up**: 把 `build.rs` 的 skill exclude 也改成 `starts_with("skills-codex")` 一致防御，列入 v0.4.12 任务
6. **Tools selective rsync (18 个 runtime helper — codex round-3 #1 扩到 baseline 刷新)**：

   **完整 list**: 9 个 baseline (现有 bundle 同步刷新) + 9 个 v0.4.11 新增 = 18 个。具体 array 见 `idea-stage/v0.4.11/sync_main_skills.sh.draft:130-148`. 关键 ref: `research_wiki.py` 在 main 已大改 (315→767 行，含 canonical `ingest_paper` API)，必须刷新否则 SKILL.md 引用断链。

   ```
   REPO_ROOT=$(git rev-parse --show-toplevel)
   for helper in \
       extract_paper_style.py \
       figure_renderer.py \
       paper_illustration_image2.py \
       overleaf_setup.sh \
       overleaf_audit.sh \
       verify_wiki_coverage.sh \
       watchdog.py \
       experiment_queue/build_manifest.py \
       experiment_queue/queue_manager.py
   do
     target="$REPO_ROOT/crates/runtime/assets/tools/$helper"
     mkdir -p "$(dirname "$target")"
     rsync -av "/tmp/aris-main/tools/$helper" "$target"
   done
   ```
   **从 v0.4.11 白名单移除（codex round-1 #6）**：
   - `meta_opt/log_event.sh` + `meta_opt/check_ready.sh` —— 是 SessionEnd hook，不是 skill runtime helper。bundle 进 binary 没用（用户的 `~/.claude/hooks/` 不会自动 deploy）。**推 v0.4.12 + CLI init-time hook copy 机制**
   
   **黑名单（不进 binary，永久驻 main `tools/`）**：
   - install_aris*.{sh,ps1} / smart_update*.{sh,ps1}（installer scripts）
   - lint_skills_helpers.sh（CI/dev tool）
   - convert_skills_to_llm_chat.py（dev export tool）
   - generate_codex_claude_review_overrides.py（dev tool）
   - experiment_queue/README.md（doc，非 runtime）
7. **写入 main snapshot SHA**:
   ```
   echo "$MAIN_SHA" > "$REPO_ROOT/crates/runtime/assets/SKILLS_SOURCE_COMMIT"
   ```
   **路径验证（codex round-2 #4 答）**: build.rs 只扫描 `assets/tools/` 和 `assets/skills/`，不会嵌入 `assets/` 根目录的 plain text 文件，所以 SKILLS_SOURCE_COMMIT 放 assets/ 根 OK。
8. 清理 `git worktree remove /tmp/aris-main`
9. 提示用户跑 `cargo build --release` 看 build.rs warning，比对预期数字（见 Step 4）

### Step 2 — Gemini alias contextual 修复（codex round-1 #1）

按用户全局 CLAUDE.md，调 Gemini MCP / CLI 时唯一正确的 model ID 是 `auto-gemini-3`（其他被服务端 429 静默降级或 404）。但**不要批量 sed**——`paper-illustration/SKILL.md:283/345` 用的是直接 REST URL `generativelanguage.googleapis.com/v1beta/models/<model>` 不是 MCP/CLI alias，`auto-gemini-3` 不是 REST 端 model ID，sed 会破坏 direct API 路径。

**操作**：sync 完后跑：
```
git grep -n 'gemini-3-pro-preview\|gemini-3-1-pro-preview\|gemini-2\.5-pro\|gemini-3-pro\b' crates/runtime/assets/skills/ > /tmp/gemini_refs.txt
```
逐行 contextual review，分两类：
- **MCP / CLI invocation context**: `mcp__codex__codex` block / `mcp__gemini-cli` / `gemini --model X --prompt` / `— reviewer-model: X` → 替换为 `auto-gemini-3`
- **REST URL / historic-version pinning / fallback**: `generativelanguage.googleapis.com/...` / "previously this was 2.5-pro" → **保留不动**

写一个 patch 文件 `idea-stage/v0.4.11/gemini_alias_patches.diff`，让 codex round-2 审 patch 内容再 apply（避免我自己拍脑袋决定边界）。

### Step 3 — CI drift check（codex round-1 #3, #7; runtime crate inline test）

**位置校正**: runtime crate 没有 `tests/` integration 目录，所有 test 是 inline `#[cfg(test)] mod tests`. 新 drift test 加在 `crates/runtime/src/cache.rs` 现有 `mod tests` 末尾（现有 `bundle_inventory_skill_md_refs_resolve_to_bundled_resources` 已在那里，本次 v0.4.11 直接扩展它 + 加 2 个新 test）.

**CI workflow 前提（codex round-2 #5）**: GitHub Actions `actions/checkout@v4` 默认 shallow checkout，没有 `origin/main` ancestor 图。`.github/workflows/ci.yml` 必须加：
```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0   # 或 fetch-tags: true + 单独 step
- run: git fetch --no-tags origin main:refs/remotes/origin/main
```

```rust
// Test 1 强化版：不只检查 file 存在，还要跟 origin/main 对比
#[test]
fn skills_source_commit_present_and_pinned() {
    // 读 crates/runtime/assets/SKILLS_SOURCE_COMMIT
    // 文件必须存在 + 40 字符 SHA + non-empty
    // 如果 CI 环境有 git (检测 `git rev-parse --verify origin/main` 成功):
    //   - origin/main HEAD 是否是 SKILLS_SOURCE_COMMIT 或 ancestor
    //   - 如果不是 ancestor → warn (not fail) "main has new commits since sync"
    // 本地 dev 环境无 origin/main 时跳过 ancestor check
}

// Test 2 with allowlist/denylist：减少 false positive
#[test]
fn skill_md_helper_references_resolvable_three_class() {
    // 1. Build allowlist from BUNDLED_RESOURCES (paths under tools/ and skills/<name>/scripts/)
    // 2. Build denylist (known intentional non-runtime):
    //    - "install_aris*.sh" / "install_aris*.ps1"
    //    - "smart_update*.sh" / "smart_update*.ps1"
    //    - "lint_skills_helpers.sh"
    //    - "convert_skills_to_llm_chat.py"
    //    - "generate_codex_claude_review_overrides.py"
    // 3. 对每个 SKILL.md，正则匹配引用 (支持多 syntax):
    //    - `python3 tools/<helper>.py`
    //    - `bash tools/<helper>.sh` / `$ARIS_REPO/tools/...`
    //    - `$ARIS_CACHE_DIR/skills/<name>/scripts/<helper>`
    //    - `.aris/tools/<helper>` (canonical resolver Layer 1)
    //    - `~/.config/aris/cache/<version>/tools/<helper>` (resolver Layer 0)
    // 4. 三类分类输出:
    //    - In allowlist → OK
    //    - In denylist → ignored (印 "skipped X documented installer refs")
    //    - Unknown / hard-missing → fail with explicit per-ref location
}

#[test]
fn skill_md_cross_skill_references_bundled() {
    // 扫每个 SKILL.md 的 "/<skill-name>" trigger
    // 排除 false positive: 跳过 markdown URL path (e.g. /api/v1/foo) 和 inline code
    //   - 限定上下文 (codex round-2 #6 加强):
    //     case-insensitive + 后跟 "skill|workflow|pipeline" 或边界符
    //   - regex: (?i)\b(?:Use|see|via|the|run|invoke)\s+`?\/([a-z][a-z0-9-]+)`?\.?(?=\s+(?:skill|workflow|pipeline)\b|[\s.,;:!?)）]|$)
    //   - 反例: "/api/v1/foo" → `/api` 后跟 `/` 不匹配; "/research-pipeline." → 行末 `.` 匹配
    //   - 包含 backtick / no-backtick / inline-code 三种 syntax
    // 检查 <name> 是否在 BUNDLED_SKILLS
    // missing → warn (not fail) — 允许 SKILL.md 引用未来 skill / 跨 v0.4.11 release 提到的 skill
}
```

**为什么 Test 3 是 warn 不 fail**: SKILL.md 互引可能包含 cross-version reference（提到 v0.5 计划中的 skill），不该 block release。Test 2 是硬门——helper 不在 binary 直接断 build。

### Step 4 — 跑 sync + build + test

```
bash tools/sync_main_skills.sh
cargo build --release 2>&1 | tee /tmp/build_v0411.log
grep "Embedded" /tmp/build_v0411.log
```

**预期 build.rs warning 数字** (round-3.5 精确化):
- **74 bundled skills** (78 main 总数 − 3 个 skills-codex* 排除 − 1 个 shared-references 不算 skill)
- **~49 helper resources** (= 18 tools/ helpers + 19 shared-references files + ~12 skill-local scripts/templates/configs)

具体数字以 build.rs 实际输出为准。第一次跑完 sync 看到的数字就是 v0.4.11 baseline，写进 CHANGELOG。

**实施顺序注意 (codex round-3.5 watch-out)**: sync_main_skills.sh 有 clean-tree preflight (`git diff --quiet` 检测), 所以**必须先 sync assets, 再 inline drift test 改 cache.rs**, 不要先改 test 再跑 sync. 实施步骤:
1. write `tools/sync_main_skills.sh` (chmod +x)
2. **跑** sync_main_skills.sh (此时 working tree clean OK)
3. **commit** sync 结果 (assets + SKILLS_SOURCE_COMMIT) 暂存或先不 commit
4. 再 inline drift tests 加到 cache.rs
5. cargo build + cargo test
6. version bump + CHANGELOG + banner
7. 一起 commit + tag

```
cargo test -p runtime --lib -- --test-threads=1
./target/release/aris doctor
./target/release/aris --version  # → 0.4.11
```

如果 build warning 数字大幅偏离预期 (e.g. <70 skills 或 >85 skills)，先 abort, 查 rsync log / build.rs scan log，再决定下一步。

**回滚策略 (codex round-3 提议)**: 如果 cargo build / cargo test 任何一步失败:
```
git restore --source=HEAD -- crates/runtime/assets/skills crates/runtime/assets/tools
rm -f crates/runtime/assets/SKILLS_SOURCE_COMMIT
git checkout HEAD -- crates/runtime/src/cache.rs    # if drift test was applied
```
然后回到 Stage 2 重新审方案。

**warn-only test 查看**: cross-skill ref test 用 `eprintln!`，`cargo test` 默认会 capture。要看具体 warn 内容必须单独跑:
```
cargo test -p runtime --lib skill_md_cross_skill_references_bundled_warn_only -- --nocapture
```

### Step 5 — Version bump + Release commit + Tag

跟 v0.4.10 模式（codex round-2 #7 明确）:

1. **Cargo.toml workspace.package.version**: `0.4.10` → `0.4.11`
2. **CHANGELOG.md**: prepend v0.4.11 section. Release 类型: "Skills bundle refresh / research workflow sync"（不是 bug-fix release，避免承诺 API 行为变化）
3. **README.md / README_CN.md** aris-code 分支 banner: 加 v0.4.11 entry，强调:
   - 同步 74 个 user-facing skills 到 main 当前状态
   - 补齐 9 个新 runtime helpers (extract_paper_style.py / figure_renderer.py / paper_illustration_image2.py / overleaf_*.sh / verify_wiki_coverage.sh / watchdog.py / experiment_queue/{build_manifest,queue_manager}.py)，**同时刷新 9 baseline helpers** (含 `research_wiki.py` 大改 315→767 行)
   - 10 个新 skill 进 bundle (含 citation-audit, kill-argument, experiment-queue, paper-talk 等)
   - Gemini MCP/CLI model alias 修正
   - 新增 bundle drift CI gate + `SKILLS_SOURCE_COMMIT` 可追踪
   - **明确说**: binary runtime 行为基本不变, 主要是 skill 文档/helper 同步
4. **git commit** (HEREDOC msg):
   ```
   git add Cargo.toml Cargo.lock CHANGELOG.md README.md README_CN.md \
           crates/runtime/assets/skills/ crates/runtime/assets/tools/ \
           crates/runtime/assets/SKILLS_SOURCE_COMMIT \
           tools/sync_main_skills.sh \
           crates/runtime/src/cache.rs \
           idea-stage/v0.4.11/
   git commit -m "release: v0.4.11 — skills bundle refresh + sync infrastructure"
   ```
5. **Annotated tag**:
   ```
   git tag -a v0.4.11 -m "v0.4.11 — skills bundle refresh + sync infrastructure"
   ```
6. **Push wait**: 按"测试通过才 push"规矩，等用户本地 `cargo build --release && ./target/release/aris doctor` 测过再 push。

跟 v0.4.10 同样的工作流: tag push 触发 release.yml 自动构建 4 平台 binary + 挂 GitHub Release。

### Step 6 — Main 分支 README 同步折叠

跟 v0.4.10 完成时一样，main 分支 README banner 折叠 `v0.4.5 → v0.4.11`，summary 加 v0.4.11 entry, fold 里加 v0.4.11 row。**在 v0.4.11 tag push + CI 成功后再做**，避免 main 抢跑。

## Critical / Important / Nice-to-have 分级（v2 — codex round-1 #8 调整）

### Critical（不修就硬卡用户 / 主路径必撞）
- **citation-audit + kill-argument 嵌入** —— `verify_paper_audits.sh` MANDATORY_AUDITS 需要 `CITATION_AUDIT.json` / `KILL_ARGUMENT.json`。v0.4.10 binary 跑 `paper-writing assurance=submission` 或 `resubmit-pipeline Phase 3` 必硬卡 BLOCKED
- **canonical resolver chain 同步** —— research-wiki diff 引用真实事故"a real user's research-wiki/ empty for a week"。硬编码 `tools/research_wiki.py` 已在生产炸过
- **experiment-queue 的 scripts/ 子目录** —— Phase 3 Arch C 把实现移到 `skills/experiment-queue/scripts/`，tools/ 下只剩 shim。只 bundle SKILL.md 漏掉 scripts/ → 直接 `helpers not found`
- **Gemini alias contextual sed** —— `paper-illustration/SKILL.md` REST URL 不能动，MCP/CLI invocation 要换 `auto-gemini-3`
- **build.rs warning 数字校正** —— 不要发版前 sanity check 用错的预期数字（74/51, 不是 78/46）
- **SKILLS_SOURCE_COMMIT drift test 加强** —— 只检查 file 存在的 test 是 false confidence

### Important（用户走 opt-in 路径才撞）
- **extract_paper_style.py bundle** —— 7 个 paper 系列 skill 共享 helper，但只在用户传 `— style-ref:` opt-in 时触发
- **overleaf-sync 的 2 个 shell helper** —— `overleaf_setup.sh` 是 Policy A skill-blocking，不 bundle 则 `/overleaf-sync setup` 立刻死，但 Overleaf 集成是 Premium feature opt-in
- **paper-writing Phase 6 / Submission Artifact** —— PROOF_AUDIT.json / PAPER_CLAIM_AUDIT.json / CITATION_AUDIT.json 链条（assurance=submission 触发）
- **proof-checker --restatement-check / --deep-fix** —— 用户传新 flag 但 binary 静默忽略
- **paper-plan/write 的 GAP_REPORT.md / DATA_NEEDED markers** —— 写作诚实度提升
- **rebuttal per-reviewer thread mode + 8 patterns**
- **assurance contract 拆 effort axis + external verifier 门**

### Nice-to-have（presentation / 投环境集成）
- paper-talk, slides-polish（presentation pipeline，W3 后的 talk 准备）
- resubmit-pipeline (W5，跨投专用)
- overleaf-sync（Premium feature 集成）
- qzcli（启智平台 GPU 任务）
- gemini-search, openalex（research-lit 已有 default 路径，新源 opt-in）

## 风险评估（v2 — codex round-1 校正）

| 风险 | 严重度 | 缓解 |
|---|---|---|
| rsync 把 symlink 拷错 → build.rs panic | 高 | sync script 跑前 `find -type l` 检查，发现立即 abort（**不依赖 rsync flag**） |
| Phase 3 Arch C scripts/ 嵌入 path 跟 SKILL.md 引用不匹配 | 中 | Agent 3 已确认 cache.rs key-driven，路径自动一致 |
| Gemini batch sed 破坏 `paper-illustration` REST URL | **高** | 改用 git grep + contextual review，**不批量 sed**，写 patch 让 codex round-2 审 |
| sync 后 binary 体积大幅增加 | 低-中 | **+0.3-0.8MB** (codex 校正，不是之前估的 +50-100KB)。10MB → ~11MB 可接受 |
| `skills-codex/` 镜像被白嵌入 | 中 | rsync 显式 `--exclude='skills-codex*'`，build.rs 已有 exclude 备份 |
| meta_opt/ hook 没法用 | 已推 v0.4.12 | v0.4.11 不 bundle，推 v0.4.12 + CLI init-time hook copy 机制 |
| `SKILLS_SOURCE_COMMIT` test 太弱 | 已修 | Test 1 加 origin/main ancestor check |
| Helper reference test false positive/negative | 已修 | 加 allowlist + denylist 三分类输出 |
| Cache 抽取冲突（v0.4.10 旧数据） | 低 | `CARGO_PKG_VERSION` 隔离 `~/.config/aris/cache/<version>/`，0.4.10 ↔ 0.4.11 互不污染。**风险**: 同 v0.4.11 不要 re-publish 不同 bundle（cache.rs 不清同版本 stale files） |
| rustc 编译 include_str 字符串过大 | 低 | build.rs:8 cap 512KB 单文件，main 最大非镜像文件约 282KB，远低于上限 |
| build.rs 数字预估错引发 release sanity check 误判 | 已修 | 预期数字校正成 74/~51，且 plan 写明"以实际为准" |
| user 误以为 5.5→5.4 要做 | 已澄清 | 不做 revert，文档跟 CLI 实际默认对齐 |
| sync 后 v0.4.10 audit 的 4 个 API P1 没修 | 低 | 推 v0.4.12，不影响 v0.4.11 ship |

## v0.4.11 范围 final (v2)

**做**:
- ✅ Full skills/ rsync (74 个 user-facing skill，**排除 skills-codex/**) + shared-references/
- ✅ Tools/ 选择性 rsync (**18 个 runtime helper** — 9 baseline 刷新 + 9 新增；skip meta_opt/ hook + 11 个 installer/dev helper)
- ✅ Gemini alias **contextual** 修复（写 patch → codex round-2 审 → 再 apply，不批量 sed）
- ✅ Sync script 自动化 (`tools/sync_main_skills.sh`)，含 symlink 前置检测
- ✅ 3 个 CI drift check tests (加强版，含 allowlist/denylist 分类)
- ✅ `SKILLS_SOURCE_COMMIT` 跟踪文件
- ✅ Version bump + CHANGELOG + 双语 README banner + tag

**不做**:
- ❌ 反向 sed 把 reviewer 默认 5.5 → 5.4（用户确认: 5.5 跑通就行，不 revert）
- ❌ skills-codex/ 镜像进 binary (build.rs 已 exclude，rsync 也 exclude)
- ❌ meta_opt/ hook bundle (推 v0.4.12 + CLI init-time hook deploy 机制)
- ❌ v0.4.10 codex audit 的 4 个 API P1（推 v0.4.12）
- ❌ build.rs 改动（agent 3 验证已支持）

## v0.4.11 工作量预估 (v2)

| 步骤 | 时长 |
|---|---|
| Step 1 sync_main_skills.sh 写脚本 + 测试 | 30min |
| Step 2 Gemini grep + patch 准备 → codex round-2/3 审 | 20min |
| Step 3 三个 CI drift test 写 + 验证 + CI workflow fetch-depth: 0 | 60min |
| Step 4 跑 sync + build + cargo test | 15min |
| Step 5 version bump + CHANGELOG + 双语 banner + tag | 25min |
| codex round-3 review 实施 diff | 30min |
| 等用户本地测试 + tag push + 监控 CI | 30min |
| Step 6 main 分支 README 折叠 | 15min |
| **总计** | **~3.5h** |

收紧到 v0.4.11 范围（不做 meta_opt hook / API P1 / skills-codex binary）后，半天内做完是稳的。

## codex round-1 + round-2 review trace

- **round-1 verdict**: REQUEST CHANGES (8 个 finding, 见上方 "v2 变更" 段)
- **round-2 verdict**: APPROVE WITH NITS (7 个 nit, 已在本文件全部修订)
- **round-3 计划**: 实施完后让 codex 审最终 diff (commit 之前)

每一步 codex 审都用 gpt-5.5 xhigh, read-only sandbox, cwd 设到 repo root。
