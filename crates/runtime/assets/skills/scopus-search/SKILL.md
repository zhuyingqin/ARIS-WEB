---
name: scopus-search
description: Search Elsevier Scopus through elsapy for peer-reviewed literature discovery, boolean query refinement, citation screening, author or affiliation lookup, DOI-to-metadata retrieval, and structured result export. Use when Codex needs Scopus-indexed coverage beyond arXiv/web search, especially for related-work surveys, exact database queries, cited-by counts, journal metadata, or reproducible literature review pipelines.
---

# Scopus Search

Use this skill to query Scopus with `elsapy` and turn a stable Scopus query into a complete exportable result set.

## Quick Start

1. Ensure `elsapy` is available in the main Python environment.
2. Provide the API key through `SCOPUS_API_KEY`.
3. Run the helper script with a Scopus boolean query.

```bash
# 在仓库根目录执行（脚本路径按仓库相对路径解析，避免硬编码绝对路径，尤其是含中文或空格的目录）
SCOPUS_API_KEY='your-key' \
python skills/scopus-search/scripts/scopus_search.py \
  'TITLE-ABS-KEY("physics-informed neural network" AND fuzzy)' \
  --get-all --json
```

Prefer environment variables over CLI flags for credentials. Do not print or persist the key unless the user explicitly asks for that.

**路径策略（Windows/中文目录必读）**：调用 `scopus_search.py` 时使用相对路径（以仓库根为 CWD），导出产物落到 `./.codex/<task>/...` 这种当前工作目录拼接的相对路径。不要把 `F:\\论文\\...` 这类含中文/空格的绝对路径作为输出目标写进命令行，Windows 下常见 CP936 编码解析问题。

## Planning & Check-in（必做）

开始执行前，必须先阅读 [共享规范](../shared-governance/planning-checkin.md)。

本技能至少执行以下确认节奏：

- `计划确认`：说明将执行的 query、是否默认全量导出、是否抓摘要、输出格式，以及是否存在用户显式要求的预览上限。
- `阶段确认 1`：如果用户明确要求预览或抽查，先回报小样本结果和是否需要扩大；如果用户要求的是完整导出，则回报 Scopus 总命中和将执行的全量导出策略。
- `阶段确认 2`：准备抓摘要或执行大规模导出时，回报范围、成本影响和失败兜底策略。
- `阶段确认 3`：最终汇总时，回报准确 query、总命中数、已导出条数、摘要覆盖情况、输出格式和局限。

默认目标是“满足搜索并导出全部结果”，而不是先缩成小样本。只有在用户明确要求预览、抽查、快速验证或成本受限时，才使用小批量模式。

### 1. Build a precise query

Start with `TITLE-ABS-KEY(...)` and add filters only when needed.

Common patterns:

- Topic search:
  ```text
  TITLE-ABS-KEY("physics-informed neural network" AND fuzzy)
  ```
- Restrict by year:
  ```text
  TITLE-ABS-KEY("physics-informed neural network" AND fuzzy) AND PUBYEAR > 2021
  ```
- Restrict to journal articles:
  ```text
  TITLE-ABS-KEY("physics-informed neural network" AND fuzzy) AND DOCTYPE(ar)
  ```
- Restrict by author or affiliation:
  ```text
  TITLE-ABS-KEY("physics-informed neural network") AND AUTHLASTNAME(karniadakis)
  TITLE-ABS-KEY("physics-informed neural network") AND AFFIL(oxford)
  ```

If you need more query syntax or elsapy behavior, read [references/elsapy.md](./references/elsapy.md).

### 2. Export all by default

If the user already provides a stable Scopus query, default to exporting the full retrievable result set instead of forcing a small sample first.

### 3. Use preview mode only when explicitly needed

Use `--count 5` or `--count 10` only when the user explicitly asks to preview titles, inspect a query quickly, or do a low-cost spot check before a full export.

### 4. Abstracts are pulled by default（通过 `view=COMPLETE` 一次性拿到）

脚本默认 `--view COMPLETE`，Scopus 搜索响应本身就带 `dc:description`、`authkeywords` 等字段，**不需要再逐条调 AbsDoc**。8000+ 条规模从原来 ~1.5 小时（串行 AbsDoc）降到 ~10 分钟（仅分页 search）。

- 默认：全部返回结果都带摘要 + 作者关键词
- 不要摘要：`--no-abstracts`
- 封顶：`--abstract-limit N`（仅在极少数 COMPLETE 漏掉 `dc:description` 的记录走 AbsDoc 兜底时生效）
- 兼容别名：`--include-abstracts` 无需显式传入
- 降级场景：`--view STANDARD` 仅在 API key 没有 COMPLETE 权限时使用；此时会自动 fallback 到 AbsDoc 抓摘要，速度回落到串行模式
- COMPLETE view 的周配额通常低于 STANDARD（Elsevier 各合约不同，常见 10k/周 vs 20k/周），大规模拉取前留意 key 剩余额度

摘要抓取失败（COMPLETE 漏字段且 AbsDoc 兜底也失败）会写入 `abstract_error`，方便下游核查。

### 5. Synthesize for the user

When using this skill in a literature review:

- Report exact query string used.
- Separate peer-reviewed results from preprints if both appear in downstream synthesis.
- Summarize by theme, not by raw API order.
- Mention Scopus citation counts as point-in-time metadata, not stable truth.

## Helper Script

**硬约束（不可违反）**：任何 Scopus 调用必须通过 `scripts/scopus_search.py` 的 CLI 接口。严禁在对话里内联编写 Python 脚本、直接 `import elsapy`、或手写 HTTP/REST 请求来绕过这个 CLI。如果该脚本启动失败（例如 `elsapy` import 失败、路径解析不到、API key 缺失），应当把错误原样回报给用户并停下等人处理，**不要自行改写脚本、不要另起炉灶用 requests 实现、不要粘贴一段 elsapy 代码直接跑**。`references/elsapy.md` 里的示例只供脚本维护者参考，不是 runtime 模板。

Use `scripts/scopus_search.py` for all direct API interaction.
Use `scripts/bootstrap_env.sh` only as a fallback when the main environment is inconsistent.

Key flags:

- `--count N`: 未使用 `--get-all` 时要返回的最大条目数；脚本会按需继续翻页，不再只停在第一页 25 条
- `--get-all`: iterate through all retrievable pages；现在即使不显式传入，当你未提供 `--count` 时脚本也会默认导出全部结果
- `--use-cursor`: enable cursor pagination for Scopus searches；当 `--count > 25` 时建议开启
- `--view COMPLETE|STANDARD`: 默认 COMPLETE，响应直接包含摘要和作者关键词，无需二次 AbsDoc。仅在 API key 没 COMPLETE 权限时降级为 STANDARD（触发 AbsDoc 兜底，慢一个数量级）
- `--no-abstracts`: 关闭摘要输出；默认对所有返回结果保留摘要
- `--include-abstracts`: 旧参数，现在是默认行为的兼容别名，无需显式传入
- `--abstract-limit N`: 封顶 AbsDoc 兜底抓取条数；`0` 表示对所有漏字段的记录都兜底抓（COMPLETE 默认路径下很少触发）
- `--json`: emit machine-readable JSON instead of a text table
- `--include-raw`: include raw Scopus payloads in JSON when debugging response fields

Examples:

所有示例都假设 CWD 是仓库根目录，输出统一落到 `./.codex/<task>/`。

```bash
python skills/scopus-search/scripts/scopus_search.py \
  'TITLE-ABS-KEY("Fuzzy-PINN" OR ("physics-informed neural network" AND fuzzy))' \
  --get-all --json > ./.codex/fuzzy-pinn-full.json
```

```bash
python skills/scopus-search/scripts/scopus_search.py \
  'TITLE-ABS-KEY(("physics-informed neural network" OR PINN) AND ("mixture of experts" OR gating OR "domain decomposition"))' \
  --get-all --abstract-limit 0 --json > ./.codex/pinn-moe-full.json
```

```bash
python skills/scopus-search/scripts/scopus_search.py \
  'TITLE-ABS-KEY("physics-informed neural network" AND fuzzy)' \
  --count 10 --json
```

## Practical Rules

- Prefer Scopus when the user wants database-backed, peer-reviewed coverage rather than arXiv-only search.
- Use the main `python3` environment when `elsapy` imports cleanly.
- **只用 CLI**：永远通过 `scripts/scopus_search.py` 调用，不允许内联 Python、`import elsapy`、手写 HTTP 或任何等价实现。脚本启动失败时（import error / 找不到脚本 / key 缺失）向用户原样报错并停下，不要"自己实现一个"。这条规则优先级高于成本、方便度或速度考量。
- Quote exact search strings in the final answer so the search is reproducible.
- If the user gives a stable query and asks for export, default to full export rather than forcing a sample pass.
- Treat `--count` as an explicit preview/spot-check knob, not the default workflow.
- Treat missing abstracts, missing authors, or empty citation counts as API coverage issues, not model errors.
- **路径规范**：始终以仓库根作为 CWD，脚本路径写 `skills/scopus-search/scripts/scopus_search.py`，导出落 `./.codex/<task>/`。禁止在命令行里硬编码 `F:\\论文\\...`、`/Users/...` 这类含中文或平台相关前缀的绝对路径——Windows cmd/PowerShell 对中文绝对路径常出现编码解析失败。

## Limitations

- `elsapy` is convenient but archived upstream; if it breaks, replace the helper script with direct Elsevier API calls instead of guessing.
- Scopus API coverage and abstract access depend on account entitlement.
- Citation counts can change over time.
