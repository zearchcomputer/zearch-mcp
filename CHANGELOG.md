# Changelog

## 0.1.0 (unreleased)

First version, published as `@zearchcomputer/mcp`.

- Tools: `research` (all six modes, follow-ups, streamed progress, queued Reverse engineer runs), `verify`, `get_run`, `list_runs`, `get_wallet`, `get_pricing`.
- Inline answer view (MCP Apps) for research and verification results, in light and dark.
- Resources: `zearch://runs/{id}`, `zearch://pricing`. Prompts: `research_brief`, `fact_check`, `compare`.
- stdio and Streamable HTTP transports; per-caller API keys in HTTP mode.
- Idempotent retries with backoff, Retry-After, cancellation, stream-drop recovery.
