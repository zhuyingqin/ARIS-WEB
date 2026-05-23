# OpenAlex API Notes

Use the official OpenAlex developer docs as the source of truth:

- Works API: https://developers.openalex.org/api-entities/works
- Searching: https://developers.openalex.org/how-to-use-the-api/get-lists-of-entities/search-entities
- Filtering: https://developers.openalex.org/how-to-use-the-api/get-lists-of-entities/filter-entity-lists
- Cursor paging: https://developers.openalex.org/how-to-use-the-api/get-lists-of-entities/paging
- Select fields: https://developers.openalex.org/how-to-use-the-api/get-lists-of-entities/select-fields
- Authentication: https://developers.openalex.org/how-to-use-the-api/authentication

Operational details to preserve:

- Query the `https://api.openalex.org/works` endpoint for literature metadata.
- Use `search=<terms>` for broad works search.
- Use `filter=<filter-expression>` for structured constraints. Commas mean AND; pipes inside a value mean OR.
- Use `select=<fields>` to keep responses small while retaining title, abstract, authorship, venue, DOI, year, citations, OpenAlex IDs, open-access links, topics, and raw location data.
- Use cursor pagination (`cursor=*`, then `meta.next_cursor`) for complete downloads, especially beyond 10,000 records.
- Reconstruct abstracts from `abstract_inverted_index`; OpenAlex does not return abstracts as a plain string in works responses.
- Keep `api_key` and `mailto` out of committed query-plan files. Prefer `OPENALEX_API_KEY` and `OPENALEX_MAILTO` environment variables.
