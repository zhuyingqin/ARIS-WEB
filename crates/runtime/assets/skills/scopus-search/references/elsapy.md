# elsapy Notes

> ⚠️ **此文档仅供脚本维护者参考**（当 `scripts/scopus_search.py` 需要修 bug 或重写底层实现时用）。
>
> **不是 runtime 调用模板**。Agent 在回答用户问题时，**严禁**把下面的 `ElsClient / ElsSearch / AbsDoc` 片段拼成脚本直接跑，也**严禁** `import elsapy` 或手写 HTTP 绕过 CLI。所有 Scopus 调用只走 `scripts/scopus_search.py` 这一个入口；脚本本身出故障时向用户报错停下，不要自写替代品。

This skill is built around the archived `ElsevierDev/elsapy` Python client.

Official sources used while building the skill:

- GitHub repository: [ElsevierDev/elsapy](https://github.com/ElsevierDev/elsapy)
- Example program: [exampleProg.py](https://github.com/ElsevierDev/elsapy/blob/master/exampleProg.py)
- Elsevier developer portal: [dev.elsevier.com](https://dev.elsevier.com/)

## What matters from elsapy

The official examples and source show the core pattern:

```python
from elsapy.elsclient import ElsClient
from elsapy.elssearch import ElsSearch
from elsapy.elsdoc import AbsDoc

client = ElsClient(api_key)
search = ElsSearch(query, "scopus")
search.execute(client, get_all=False, use_cursor=False, view="STANDARD", count=25)
```

For abstract lookup:

```python
doc = AbsDoc(scp_id=84872135457)
doc.read(client)
```

## Search behavior to remember

- The Scopus search index name is `scopus`.
- `ElsSearch.execute(...)` accepts:
  - `get_all`
  - `use_cursor`
  - `view`
  - `count`
- `search.results` is a list of raw result dictionaries.
- `search.tot_num_res` is the total number of hits reported by Scopus.

## Query-writing guidance

Start simple and add filters incrementally.

Useful query fragments:

- `TITLE-ABS-KEY(term)`
- `PUBYEAR > 2021`
- `DOCTYPE(ar)`
- `AUTHLASTNAME(name)`
- `AFFIL(org)`

Example:

```text
TITLE-ABS-KEY(("physics-informed neural network" OR PINN) AND fuzzy) AND PUBYEAR > 2021 AND DOCTYPE(ar)
```

## Dependency note

`elsapy` was archived on GitHub on January 13, 2025. Use it because the user explicitly requested it, but do not assume future maintenance. If imports or response parsing break, switch the skill implementation to direct Elsevier REST calls while keeping the same CLI surface.

## Installation

Prefer the main `python3` environment when `elsapy` imports cleanly. If the system/user Python stack becomes inconsistent, fall back to the skill-local bootstrap script.

If `elsapy` is missing:

```bash
python3 -m pip install --user elsapy pandas
```

Fallback:

```bash
# 仓库根目录执行
bash skills/scopus-search/scripts/bootstrap_env.sh
```

That fallback script creates `.venv` inside the skill directory and installs:

- `pip`
- `elsapy`
- `pandas`

If the environment blocks network access, request approval and retry with elevated permissions.
