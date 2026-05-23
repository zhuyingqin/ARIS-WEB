#!/usr/bin/env python3
"""Export OpenAlex works for every query in a reproducible query plan."""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


API_URL = "https://api.openalex.org/works"
DEFAULT_PER_PAGE = 200
DEFAULT_SELECT = ",".join(
    [
        "id",
        "doi",
        "title",
        "display_name",
        "publication_year",
        "publication_date",
        "type",
        "language",
        "cited_by_count",
        "is_retracted",
        "is_paratext",
        "authorships",
        "primary_location",
        "best_oa_location",
        "open_access",
        "abstract_inverted_index",
        "topics",
        "primary_topic",
        "ids",
        "referenced_works_count",
    ]
)

CSV_FIELDS = [
    "query_name",
    "query_index",
    "rank_in_query",
    "matched_queries",
    "openalex_id",
    "doi",
    "title",
    "abstract",
    "publication_year",
    "publication_date",
    "type",
    "language",
    "cited_by_count",
    "is_retracted",
    "is_paratext",
    "authors",
    "author_openalex_ids",
    "institutions",
    "countries",
    "source_display_name",
    "source_openalex_id",
    "source_type",
    "issn_l",
    "is_oa",
    "oa_status",
    "landing_page_url",
    "pdf_url",
    "best_oa_url",
    "primary_topic",
    "topics",
    "referenced_works_count",
    "ids_json",
]

TITLE_ABSTRACT_FIELDS = [
    "query_name",
    "matched_queries",
    "openalex_id",
    "doi",
    "title",
    "abstract",
    "publication_year",
    "publication_date",
    "type",
    "cited_by_count",
    "source_display_name",
    "landing_page_url",
    "pdf_url",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download OpenAlex works metadata for every query expression in a JSON query plan."
    )
    parser.add_argument("--queries", required=True, help="Path to query-plan JSON.")
    parser.add_argument("--out", required=True, help="Output directory.")
    parser.add_argument("--api-key", default=os.environ.get("OPENALEX_API_KEY"), help="OpenAlex API key.")
    parser.add_argument("--mailto", default=os.environ.get("OPENALEX_MAILTO"), help="Contact email for OpenAlex.")
    parser.add_argument("--endpoint", default=API_URL, help="OpenAlex works endpoint.")
    parser.add_argument("--per-page", type=int, default=DEFAULT_PER_PAGE, help="Results per page, max 200.")
    parser.add_argument("--sleep", type=float, default=0.12, help="Delay between successful page requests.")
    parser.add_argument("--timeout", type=float, default=60.0, help="HTTP timeout in seconds.")
    parser.add_argument("--max-retries", type=int, default=5, help="Retries for 429/5xx responses.")
    parser.add_argument("--dry-run", action="store_true", help="Fetch only counts and write query_counts.csv.")
    parser.add_argument("--max-results", type=int, default=0, help="Optional cap per query; 0 means complete export.")
    parser.add_argument("--max-pages", type=int, default=0, help="Optional cap per query; 0 means no page cap.")
    parser.add_argument("--select", default=None, help="Override selected OpenAlex fields.")
    parser.add_argument(
        "--insecure-skip-verify",
        action="store_true",
        help="Disable TLS certificate verification only when local CA configuration is broken.",
    )
    return parser.parse_args()


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def slugify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9._-]+", "-", value)
    value = re.sub(r"-{2,}", "-", value).strip("-")
    return value or "query"


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")


def write_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True))
            handle.write("\n")


def write_csv(path: Path, rows: list[dict[str, Any]], fields: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, "") for field in fields})


def load_plan(path: Path) -> dict[str, Any]:
    payload = read_json(path)
    if isinstance(payload, list):
        payload = {"project": path.stem, "queries": payload}
    if not isinstance(payload, dict):
        raise SystemExit("Query plan must be a JSON object or a list of query objects.")
    queries = payload.get("queries")
    if not isinstance(queries, list) or not queries:
        raise SystemExit("Query plan must contain a non-empty 'queries' list.")
    normalized_queries = []
    seen_names: set[str] = set()
    for index, query in enumerate(queries, start=1):
        if isinstance(query, str):
            query = {"name": f"query_{index:02d}", "search": query}
        if not isinstance(query, dict):
            raise SystemExit(f"Query #{index} must be a string or JSON object.")
        name = slugify(str(query.get("name") or f"query_{index:02d}"))
        if name in seen_names:
            name = f"{name}-{index:02d}"
        seen_names.add(name)
        normalized = dict(query)
        normalized["name"] = name
        normalized["index"] = index
        normalized_queries.append(normalized)
    payload["queries"] = normalized_queries
    payload.setdefault("project", path.stem)
    payload.setdefault("shared", {})
    if not isinstance(payload["shared"], dict):
        raise SystemExit("'shared' must be a JSON object when provided.")
    return payload


def combine_filters(shared_filter: str | None, query_filter: str | None) -> str | None:
    parts = [part.strip() for part in [shared_filter, query_filter] if part and part.strip()]
    return ",".join(parts) if parts else None


def build_params(
    plan: dict[str, Any], query: dict[str, Any], args: argparse.Namespace, cursor: str | None
) -> dict[str, str | int]:
    shared = plan.get("shared", {})
    params: dict[str, str | int] = {"per-page": args.per_page}

    search = query.get("search", shared.get("search"))
    if search:
        params["search"] = str(search)

    filter_expr = combine_filters(shared.get("filter"), query.get("filter"))
    if filter_expr:
        params["filter"] = filter_expr

    sort = query.get("sort", shared.get("sort"))
    if sort:
        params["sort"] = str(sort)

    select = query.get("select", shared.get("select", args.select or DEFAULT_SELECT))
    if select:
        params["select"] = str(select)

    if args.api_key:
        params["api_key"] = args.api_key
    if args.mailto:
        params["mailto"] = args.mailto
    if cursor is not None:
        params["cursor"] = cursor
    return params


def public_params(params: dict[str, Any]) -> dict[str, Any]:
    safe = dict(params)
    if "api_key" in safe:
        safe["api_key"] = "<redacted>"
    return safe


def request_json(
    endpoint: str,
    params: dict[str, str | int],
    timeout: float,
    max_retries: int,
    ssl_context: ssl.SSLContext,
) -> dict[str, Any]:
    query_string = urllib.parse.urlencode(params)
    url = f"{endpoint}?{query_string}"
    last_error: Exception | None = None
    for attempt in range(max_retries + 1):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "codex-openalex-search/0.1"})
            with urllib.request.urlopen(request, timeout=timeout, context=ssl_context) as response:
                body = response.read().decode("utf-8")
                return json.loads(body)
        except urllib.error.HTTPError as exc:
            last_error = exc
            body = exc.read().decode("utf-8", errors="replace")
            retryable = exc.code == 429 or 500 <= exc.code < 600
            if not retryable or attempt >= max_retries:
                raise RuntimeError(f"OpenAlex HTTP {exc.code}: {body[:1000]}") from exc
            retry_after = exc.headers.get("Retry-After")
            delay = float(retry_after) if retry_after and retry_after.isdigit() else min(60.0, 2.0**attempt)
            time.sleep(delay)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = exc
            if attempt >= max_retries:
                break
            time.sleep(min(60.0, 2.0**attempt))
    raise RuntimeError(f"OpenAlex request failed after retries: {last_error}")


def build_ssl_context(insecure_skip_verify: bool) -> ssl.SSLContext:
    if insecure_skip_verify:
        return ssl._create_unverified_context()
    try:
        import certifi  # type: ignore

        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def reconstruct_abstract(inverted_index: Any) -> str:
    if not isinstance(inverted_index, dict) or not inverted_index:
        return ""
    max_position = -1
    for positions in inverted_index.values():
        if isinstance(positions, list):
            for position in positions:
                if isinstance(position, int) and position > max_position:
                    max_position = position
    if max_position < 0:
        return ""
    words = [""] * (max_position + 1)
    for word, positions in inverted_index.items():
        if not isinstance(positions, list):
            continue
        for position in positions:
            if isinstance(position, int) and 0 <= position <= max_position:
                words[position] = str(word)
    return " ".join(word for word in words if word)


def join_unique(values: list[str]) -> str:
    seen: set[str] = set()
    output: list[str] = []
    for value in values:
        value = value.strip()
        if value and value not in seen:
            seen.add(value)
            output.append(value)
    return "; ".join(output)


def source_from_location(location: Any) -> dict[str, Any]:
    if not isinstance(location, dict):
        return {}
    source = location.get("source")
    return source if isinstance(source, dict) else {}


def flatten_work(
    work: dict[str, Any],
    query_name: str,
    query_index: int,
    rank_in_query: int,
    matched_queries: list[str] | None = None,
) -> dict[str, Any]:
    authorships = work.get("authorships") if isinstance(work.get("authorships"), list) else []
    authors: list[str] = []
    author_ids: list[str] = []
    institutions: list[str] = []
    countries: list[str] = []
    for authorship in authorships:
        if not isinstance(authorship, dict):
            continue
        author = authorship.get("author") if isinstance(authorship.get("author"), dict) else {}
        if author.get("display_name"):
            authors.append(str(author["display_name"]))
        if author.get("id"):
            author_ids.append(str(author["id"]))
        for institution in authorship.get("institutions") or []:
            if isinstance(institution, dict):
                if institution.get("display_name"):
                    institutions.append(str(institution["display_name"]))
                if institution.get("country_code"):
                    countries.append(str(institution["country_code"]))

    primary_location = work.get("primary_location") if isinstance(work.get("primary_location"), dict) else {}
    best_oa_location = work.get("best_oa_location") if isinstance(work.get("best_oa_location"), dict) else {}
    source = source_from_location(primary_location)
    open_access = work.get("open_access") if isinstance(work.get("open_access"), dict) else {}
    topics = work.get("topics") if isinstance(work.get("topics"), list) else []
    primary_topic = work.get("primary_topic") if isinstance(work.get("primary_topic"), dict) else {}

    return {
        "query_name": query_name,
        "query_index": query_index,
        "rank_in_query": rank_in_query,
        "matched_queries": "; ".join(matched_queries or [query_name]),
        "openalex_id": work.get("id", ""),
        "doi": work.get("doi", ""),
        "title": work.get("title") or work.get("display_name") or "",
        "abstract": reconstruct_abstract(work.get("abstract_inverted_index")),
        "publication_year": work.get("publication_year", ""),
        "publication_date": work.get("publication_date", ""),
        "type": work.get("type", ""),
        "language": work.get("language", ""),
        "cited_by_count": work.get("cited_by_count", ""),
        "is_retracted": work.get("is_retracted", ""),
        "is_paratext": work.get("is_paratext", ""),
        "authors": join_unique(authors),
        "author_openalex_ids": join_unique(author_ids),
        "institutions": join_unique(institutions),
        "countries": join_unique(countries),
        "source_display_name": source.get("display_name", ""),
        "source_openalex_id": source.get("id", ""),
        "source_type": source.get("type", ""),
        "issn_l": source.get("issn_l", ""),
        "is_oa": open_access.get("is_oa", ""),
        "oa_status": open_access.get("oa_status", ""),
        "landing_page_url": primary_location.get("landing_page_url", ""),
        "pdf_url": primary_location.get("pdf_url", ""),
        "best_oa_url": best_oa_location.get("landing_page_url") or best_oa_location.get("pdf_url") or "",
        "primary_topic": primary_topic.get("display_name", ""),
        "topics": join_unique([str(topic.get("display_name")) for topic in topics if isinstance(topic, dict) and topic.get("display_name")]),
        "referenced_works_count": work.get("referenced_works_count", ""),
        "ids_json": json.dumps(work.get("ids") or {}, ensure_ascii=False, sort_keys=True),
    }


def fetch_count(
    plan: dict[str, Any],
    query: dict[str, Any],
    args: argparse.Namespace,
    ssl_context: ssl.SSLContext,
) -> tuple[int, dict[str, Any]]:
    count_args = argparse.Namespace(**vars(args))
    count_args.per_page = 1
    params = build_params(plan, query, count_args, cursor=None)
    response = request_json(args.endpoint, params, args.timeout, args.max_retries, ssl_context)
    meta = response.get("meta") if isinstance(response.get("meta"), dict) else {}
    return int(meta.get("count") or 0), public_params(params)


def fetch_query(
    plan: dict[str, Any],
    query: dict[str, Any],
    args: argparse.Namespace,
    ssl_context: ssl.SSLContext,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    cursor = "*"
    page = 0
    pages_downloaded = 0
    rows: list[dict[str, Any]] = []
    raw_records: list[dict[str, Any]] = []
    count = 0
    next_cursor = cursor
    params_for_manifest: dict[str, Any] | None = None

    while next_cursor:
        if args.max_pages and page >= args.max_pages:
            break
        params = build_params(plan, query, args, cursor=next_cursor)
        if params_for_manifest is None:
            params_for_manifest = public_params(params)
        response = request_json(args.endpoint, params, args.timeout, args.max_retries, ssl_context)
        meta = response.get("meta") if isinstance(response.get("meta"), dict) else {}
        if page == 0:
            count = int(meta.get("count") or 0)
        results = response.get("results") if isinstance(response.get("results"), list) else []
        if not results:
            break
        pages_downloaded += 1
        for work in results:
            if not isinstance(work, dict):
                continue
            rank = len(rows) + 1
            row = flatten_work(work, query["name"], int(query["index"]), rank)
            rows.append(row)
            raw_records.append(
                {
                    "query_name": query["name"],
                    "query_index": int(query["index"]),
                    "rank_in_query": rank,
                    "openalex_id": row.get("openalex_id", ""),
                    "doi": row.get("doi", ""),
                    "title": row.get("title", ""),
                    "abstract": row.get("abstract", ""),
                    "work": work,
                }
            )
            if args.max_results and len(rows) >= args.max_results:
                break
        if args.max_results and len(rows) >= args.max_results:
            break
        next_cursor = meta.get("next_cursor")
        page += 1
        if args.sleep > 0:
            time.sleep(args.sleep)

    metadata = {
        "name": query["name"],
        "index": int(query["index"]),
        "reported_count": count,
        "downloaded_count": len(rows),
        "pages_downloaded": pages_downloaded,
        "params": params_for_manifest or public_params(build_params(plan, query, args, cursor="*")),
        "raw_records": raw_records,
    }
    return rows, metadata


def dedupe_rows(rows: list[dict[str, Any]], raw_records: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    by_id: dict[str, dict[str, Any]] = {}
    raw_by_id: dict[str, dict[str, Any]] = {}
    matched: dict[str, list[str]] = {}
    for row, raw in zip(rows, raw_records):
        work = raw.get("work") if isinstance(raw.get("work"), dict) else {}
        key = str(row.get("openalex_id") or row.get("doi") or f"row-{len(by_id)+1}")
        if key not in by_id:
            by_id[key] = dict(row)
            raw_by_id[key] = {"matched_queries": [], "row": dict(row), "work": work}
            matched[key] = []
        query_name = str(row.get("query_name") or "")
        if query_name and query_name not in matched[key]:
            matched[key].append(query_name)
    deduped_rows: list[dict[str, Any]] = []
    deduped_raw: list[dict[str, Any]] = []
    for key, row in by_id.items():
        row = dict(row)
        row["matched_queries"] = "; ".join(matched[key])
        deduped_rows.append(row)
        deduped_raw.append(
            {
                "matched_queries": matched[key],
                "openalex_id": row.get("openalex_id", ""),
                "doi": row.get("doi", ""),
                "title": row.get("title", ""),
                "abstract": row.get("abstract", ""),
                "work": raw_by_id[key]["work"],
            }
        )
    return deduped_rows, deduped_raw


def main() -> int:
    args = parse_args()
    if args.per_page < 1 or args.per_page > 200:
        raise SystemExit("--per-page must be between 1 and 200.")

    query_path = Path(args.queries).expanduser().resolve()
    out_dir = Path(args.out).expanduser().resolve()
    queries_dir = out_dir / "queries"
    out_dir.mkdir(parents=True, exist_ok=True)
    queries_dir.mkdir(parents=True, exist_ok=True)

    plan = load_plan(query_path)
    ssl_context = build_ssl_context(args.insecure_skip_verify)
    manifest: dict[str, Any] = {
        "project": plan.get("project"),
        "description": plan.get("description", ""),
        "query_plan": str(query_path),
        "output_dir": str(out_dir),
        "started_at": utc_now(),
        "dry_run": bool(args.dry_run),
        "endpoint": args.endpoint,
        "per_page": args.per_page,
        "queries": [],
    }

    count_rows: list[dict[str, Any]] = []
    all_rows: list[dict[str, Any]] = []
    all_raw_records: list[dict[str, Any]] = []

    for query in plan["queries"]:
        if args.dry_run:
            count, params = fetch_count(plan, query, args, ssl_context)
            count_row = {
                "query_name": query["name"],
                "query_index": int(query["index"]),
                "reported_count": count,
                "downloaded_count": 0,
                "pages_downloaded": 0,
            }
            count_rows.append(count_row)
            manifest["queries"].append({**count_row, "params": params})
            print(f"[dry-run] {query['name']}: {count} works")
            continue

        rows, metadata = fetch_query(plan, query, args, ssl_context)
        raw_records = metadata.pop("raw_records")
        write_csv(queries_dir / f"{query['name']}.csv", rows, CSV_FIELDS)
        write_csv(queries_dir / f"{query['name']}_title_abstract.csv", rows, TITLE_ABSTRACT_FIELDS)
        write_jsonl(queries_dir / f"{query['name']}.jsonl", raw_records)
        count_row = {
            "query_name": query["name"],
            "query_index": int(query["index"]),
            "reported_count": metadata["reported_count"],
            "downloaded_count": metadata["downloaded_count"],
            "pages_downloaded": metadata["pages_downloaded"],
        }
        count_rows.append(count_row)
        manifest["queries"].append(metadata)
        all_rows.extend(rows)
        all_raw_records.extend(raw_records)
        print(f"[export] {query['name']}: {len(rows)} / {metadata['reported_count']} works")

    count_fields = ["query_name", "query_index", "reported_count", "downloaded_count", "pages_downloaded"]
    write_csv(out_dir / "query_counts.csv", count_rows, count_fields)

    if not args.dry_run:
        deduped_rows, deduped_raw = dedupe_rows(all_rows, all_raw_records)
        write_csv(out_dir / "all_results_deduped.csv", deduped_rows, CSV_FIELDS)
        write_csv(out_dir / "all_title_abstract_deduped.csv", deduped_rows, TITLE_ABSTRACT_FIELDS)
        write_jsonl(out_dir / "all_results_deduped.jsonl", deduped_raw)
        manifest["total_downloaded_rows"] = len(all_rows)
        manifest["total_deduped_works"] = len(deduped_rows)

    manifest["finished_at"] = utc_now()
    write_json(out_dir / "manifest.json", manifest)
    print(f"[done] wrote outputs to {out_dir}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("Interrupted.", file=sys.stderr)
        raise SystemExit(130)
