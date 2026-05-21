#!/usr/bin/env python3
"""Search Scopus via elsapy and print structured results."""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


DEFAULT_PAGE_SIZE = 25


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Search Scopus via elsapy and print structured results.",
    )
    parser.add_argument("query", help="Scopus query string, e.g. TITLE-ABS-KEY(...).")
    parser.add_argument(
        "--count",
        type=int,
        default=None,
        help="Maximum number of entries to return in preview mode. Omit it to export all results by default.",
    )
    parser.add_argument(
        "--view",
        default="COMPLETE",
        help="Scopus search view passed to elsapy. COMPLETE returns abstracts in one shot (default). Use STANDARD only when the API key lacks COMPLETE entitlement.",
    )
    parser.add_argument(
        "--get-all",
        action="store_true",
        help="Retrieve all available pages that elsapy can iterate through.",
    )
    parser.add_argument(
        "--use-cursor",
        action="store_true",
        help="Enable cursor pagination for the search request.",
    )
    abstract_group = parser.add_mutually_exclusive_group()
    abstract_group.add_argument(
        "--include-abstracts",
        action="store_true",
        help="Deprecated alias kept for backward compatibility; abstracts are fetched by default now.",
    )
    abstract_group.add_argument(
        "--no-abstracts",
        action="store_true",
        help="Skip abstract fetching. By default, abstracts are fetched for all returned results.",
    )
    parser.add_argument(
        "--abstract-limit",
        type=int,
        default=0,
        help="Maximum number of abstracts to fetch when abstract fetching is enabled. 0 means all returned entries.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit JSON instead of a text table.",
    )
    parser.add_argument(
        "--include-raw",
        action="store_true",
        help="Include the raw Scopus entry payload in JSON output.",
    )
    return parser


def load_api_key() -> str:
    api_key = os.environ.get("SCOPUS_API_KEY", "").strip()
    if api_key:
        return api_key
    raise SystemExit(
        "SCOPUS_API_KEY is not set. Export the key in the shell before running this script."
    )


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="replace")


def import_elsapy() -> tuple[Any, Any, Any]:
    try:
        from elsapy.elsclient import ElsClient
        from elsapy.elsdoc import AbsDoc
        from elsapy.elssearch import ElsSearch
    except ImportError as exc:
        raise SystemExit(
            "elsapy is not installed. Run `scripts/bootstrap_env.sh` and use the skill-local "
            "`.venv/bin/python` interpreter."
        ) from exc
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(
            "elsapy failed to import cleanly. The current Python environment is likely inconsistent. "
            "Run `scripts/bootstrap_env.sh` and use the skill-local `.venv/bin/python` interpreter. "
            f"Original error: {exc}"
        ) from exc
    return ElsClient, ElsSearch, AbsDoc


def parse_scopus_id(entry: dict[str, Any]) -> str | None:
    raw = entry.get("dc:identifier", "")
    if not raw:
        return None
    if ":" in raw:
        return raw.rsplit(":", 1)[-1]
    return raw


def compact_authors(entry: dict[str, Any]) -> list[str]:
    authors = entry.get("author")
    if not isinstance(authors, list):
        creator = entry.get("dc:creator")
        return [str(creator)] if creator else []
    names: list[str] = []
    for author in authors:
        if not isinstance(author, dict):
            continue
        name = author.get("authname") or author.get("ce:indexed-name")
        if name:
            names.append(str(name))
    if names:
        return names
    creator = entry.get("dc:creator")
    return [str(creator)] if creator else []


def compact_affiliations(entry: dict[str, Any]) -> list[str]:
    affils = entry.get("affiliation")
    if not isinstance(affils, list):
        return []
    names: list[str] = []
    for affil in affils:
        if not isinstance(affil, dict):
            continue
        name = affil.get("affilname")
        if name:
            names.append(str(name))
    return names


def extract_keywords(entry: dict[str, Any]) -> list[str]:
    raw = entry.get("authkeywords")
    if not raw:
        return []
    if isinstance(raw, str):
        parts = [p.strip() for p in raw.replace("|", ";").split(";")]
        return [p for p in parts if p]
    if isinstance(raw, list):
        out: list[str] = []
        for item in raw:
            if isinstance(item, str) and item.strip():
                out.append(item.strip())
            elif isinstance(item, dict):
                name = item.get("$") or item.get("keyword") or item.get("authkeyword")
                if name:
                    out.append(str(name).strip())
        return out
    return []


def normalize_entry(entry: dict[str, Any], include_raw: bool = False) -> dict[str, Any]:
    prism_cover_date = entry.get("prism:coverDate")
    citedby = entry.get("citedby-count")
    open_access = entry.get("openaccess")
    abstract_text = entry.get("dc:description")
    normalized = {
        "title": entry.get("dc:title"),
        "scopus_id": parse_scopus_id(entry),
        "eid": entry.get("eid"),
        "doi": entry.get("prism:doi"),
        "publication_name": entry.get("prism:publicationName"),
        "cover_date": prism_cover_date,
        "year": str(prism_cover_date).split("-", 1)[0] if prism_cover_date else None,
        "subtype": entry.get("subtypeDescription") or entry.get("subtype"),
        "citedby_count": int(citedby) if str(citedby).isdigit() else citedby,
        "openaccess": open_access,
        "authors": compact_authors(entry),
        "affiliations": compact_affiliations(entry),
        "keywords": extract_keywords(entry),
        "abstract": abstract_text if abstract_text else None,
    }
    if include_raw:
        normalized["raw"] = entry
    return normalized


def fetch_abstracts(
    client: Any,
    abs_doc_cls: Any,
    entries: list[dict[str, Any]],
    limit: int,
) -> None:
    fetched = 0
    for entry in entries:
        scopus_id = entry.get("scopus_id")
        if not scopus_id:
            continue
        if limit > 0 and fetched >= limit:
            break
        try:
            doc = abs_doc_cls(scp_id=scopus_id)
            if not doc.read(client):
                entry["abstract_error"] = "AbsDoc.read returned False"
                continue
        except Exception as exc:  # noqa: BLE001
            entry["abstract_error"] = str(exc)
            fetched += 1
            continue

        coredata = getattr(doc, "data", {}).get("coredata", {})
        item = getattr(doc, "data", {}).get("item", {})
        bibrecord = item.get("bibrecord", {}) if isinstance(item, dict) else {}

        abstract_text = None
        if isinstance(coredata, dict):
            abstract_text = coredata.get("dc:description")

        if not abstract_text and isinstance(bibrecord, dict):
            head = bibrecord.get("head", {})
            abstract_node = head.get("abstracts")
            if isinstance(abstract_node, dict):
                abstract_text = abstract_node.get("ce:abstract")

        entry["abstract"] = abstract_text
        if not abstract_text:
            entry["abstract_error"] = (
                "Abstract payload missing: no coredata.dc:description or bibrecord abstract"
            )
        fetched += 1


def with_query_params(url: str, **params: Any) -> str:
    parts = urlsplit(url)
    query_items = dict(parse_qsl(parts.query, keep_blank_values=True))
    for key, value in params.items():
        if value is None:
            continue
        query_items[key] = str(value)
    return urlunsplit(
        (
            parts.scheme,
            parts.netloc,
            parts.path,
            urlencode(query_items, doseq=True),
            parts.fragment,
        )
    )


def extract_search_entries(api_response: dict[str, Any]) -> list[dict[str, Any]]:
    payload = api_response.get("search-results", {})
    entries = payload.get("entry", [])
    if isinstance(entries, list):
        return [entry for entry in entries if isinstance(entry, dict)]
    if isinstance(entries, dict):
        return [entries]
    return []


def extract_total_hits(api_response: dict[str, Any]) -> int | None:
    raw_total = api_response.get("search-results", {}).get("opensearch:totalResults")
    if isinstance(raw_total, int):
        return raw_total
    if isinstance(raw_total, str) and raw_total.isdigit():
        return int(raw_total)
    return None


def extract_next_url(api_response: dict[str, Any]) -> str | None:
    links = api_response.get("search-results", {}).get("link", [])
    if not isinstance(links, list):
        return None
    for link in links:
        if not isinstance(link, dict):
            continue
        if link.get("@ref") == "next":
            href = link.get("@href")
            if href:
                return str(href)
    return None


def fetch_search_results(
    client: Any,
    search: Any,
    requested_count: int,
    view: str,
    get_all: bool,
    use_cursor: bool,
) -> tuple[list[dict[str, Any]], int | None]:
    # Scopus API 默认只返回 25 条。这里显式沿着 next 链接继续抓取，直到达到目标条数。
    page_size = min(requested_count, DEFAULT_PAGE_SIZE)
    effective_use_cursor = use_cursor or get_all or requested_count > DEFAULT_PAGE_SIZE
    next_url = with_query_params(
        search.uri,
        cursor="*" if effective_use_cursor else None,
        view=view,
        count=page_size,
    )
    collected: list[dict[str, Any]] = []
    total_hits: int | None = None
    target_count = None if get_all else requested_count

    while next_url:
        api_response = client.exec_request(next_url)
        if total_hits is None:
            total_hits = extract_total_hits(api_response)
        collected.extend(extract_search_entries(api_response))

        if target_count is not None and len(collected) >= target_count:
            return collected[:target_count], total_hits

        next_url = extract_next_url(api_response)

    return collected, total_hits


def render_text(entries: list[dict[str, Any]], total_hits: Any, query: str) -> str:
    lines = [
        f"Query: {query}",
        f"Total hits reported by Scopus: {total_hits}",
        f"Returned entries: {len(entries)}",
        "",
    ]
    for idx, entry in enumerate(entries, start=1):
        authors = ", ".join(entry["authors"][:5]) if entry["authors"] else "N/A"
        venue = entry.get("publication_name") or "N/A"
        year = entry.get("year") or "N/A"
        cited = entry.get("citedby_count")
        cited_text = "N/A" if cited in (None, "") else str(cited)
        doi = entry.get("doi") or "N/A"
        lines.extend(
            [
                f"{idx}. {entry.get('title') or 'Untitled'}",
                f"   Year: {year} | Venue: {venue}",
                f"   Citations: {cited_text} | DOI: {doi}",
                f"   Authors: {authors}",
            ]
        )
        if entry.get("abstract"):
            lines.append(f"   Abstract: {entry['abstract']}")
        if entry.get("abstract_error"):
            lines.append(f"   Abstract fetch error: {entry['abstract_error']}")
        lines.append("")
    return "\n".join(lines).rstrip()


def main() -> int:
    configure_stdio()
    parser = build_parser()
    args = parser.parse_args()

    if args.count is not None and args.count <= 0:
        parser.error("--count must be positive when provided.")
    if args.abstract_limit < 0:
        parser.error("--abstract-limit cannot be negative.")

    effective_get_all = args.get_all or args.count is None
    requested_count = args.count if args.count is not None else DEFAULT_PAGE_SIZE
    effective_include_abstracts = not args.no_abstracts

    api_key = load_api_key()
    ElsClient, ElsSearch, AbsDoc = import_elsapy()

    client = ElsClient(api_key)
    search = ElsSearch(args.query, "scopus")
    search_results, total_hits = fetch_search_results(
        client,
        search,
        requested_count,
        args.view,
        effective_get_all,
        args.use_cursor,
    )

    normalized_entries = [
        normalize_entry(entry, include_raw=args.include_raw) for entry in search_results
    ]

    if effective_include_abstracts and normalized_entries:
        missing_abstract_entries = [
            entry for entry in normalized_entries if not entry.get("abstract")
        ]
        if missing_abstract_entries:
            # Fallback path: only hit AbsDoc for entries the search view did not
            # already carry abstracts for (e.g. view=STANDARD, or COMPLETE records
            # that happen to lack dc:description).
            fetch_abstracts(
                client, AbsDoc, missing_abstract_entries, args.abstract_limit
            )
    elif not effective_include_abstracts:
        # Honor --no-abstracts even when the search view already carried dc:description.
        for entry in normalized_entries:
            entry["abstract"] = None

    payload = {
        "query": args.query,
        "total_hits": total_hits,
        "returned_entries": len(normalized_entries),
        "entries": normalized_entries,
    }

    if args.json:
        json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    else:
        sys.stdout.write(render_text(normalized_entries, payload["total_hits"], args.query))
        sys.stdout.write("\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
