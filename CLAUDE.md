# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

An MCP (Model Context Protocol) server that exposes [OpenGrok](https://oracle.github.io/opengrok/) code search as a small set of MCP tools. It calls the OpenGrok REST API (`/api/v1/search`, `/api/v1/projects`) against whatever instance is pointed at by `OPENGROK_URL`.

**This is an stdio MCP server.** It is spawned as a child process by an MCP client (Claude Code, VS Code, Cursor, …) and speaks JSON-RPC over stdin/stdout. It is not an HTTP/SSE server, not a daemon, and not meant to be run as a long-lived service. `npm start` appearing to hang is the correct behavior — the process is waiting for a JSON-RPC handshake on stdin.

## Build, run, test

```sh
npm install
npm run build    # tsc && shx chmod +x dist/*.js
npm start        # node dist/index.js — speaks MCP over stdio
npm test         # tsx + node:test — runs the unit suite in tests/
```

TypeScript is `strict: true`. Tests import pure helpers directly from `src/index.ts`; that file guards `main()` at the bottom so importing the module does not start the server.

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `OPENGROK_URL` | yes | Base URL of the OpenGrok instance (no trailing `/source`) |
| `OPENGROK_USERNAME` | no | HTTP basic auth username |
| `OPENGROK_PASSWORD` | no | HTTP basic auth password |

The server always sends an `X-Forwarded-For: 127.0.0.1` header. This is intentional — it lets the server bypass `oauth2-proxy`-style reverse proxies that whitelist localhost when reached via an SSH tunnel from the proxy host. Harmless when OpenGrok is exposed directly. **Do not "clean it up".**

## Architecture

- **Runtime:** Node.js 18+, ESM, TypeScript → ES2020, `strict: true`.
- **Dependencies:** `@modelcontextprotocol/sdk`, `axios`, `zod`. Dev: `typescript`, `tsx`, `shx`, `@types/node`. Keep this list minimal.
- **File layout:** the whole server lives in `src/index.ts` — `createClient`, the formatters (`formatSearchResponse`, `formatProjects`, `formatError`), `runTool`, `search`, and six `server.tool(...)` registrations. Unit tests live in `tests/format.test.ts` and exercise the exported pure functions.
- **Shared HTTP client:** a single module-level `axios` instance created in `main()`, with a 30-second timeout and the `X-Forwarded-For` header. Do not create new clients ad-hoc.
- **Lazy initialization:** `createClient()` runs inside `main()`, not at module load. Env-var validation also happens there. Importing `src/index.ts` has no side effects beyond registering the tools on the (unconnected) `McpServer` instance.

## MCP tools

All tools are namespaced with the `opengrok_` prefix (to avoid collisions with other MCP servers or legacy versions). Each search-tool handler translates its schema field into the OpenGrok query parameter inside the closure.

| Tool | Primary schema field | OpenGrok endpoint / param |
|------|----------------------|---------------------------|
| `opengrok_search_full_text` | `query` | `/api/v1/search?full=` |
| `opengrok_search_definition` | `definition` | `/api/v1/search?def=` |
| `opengrok_search_symbol` | `symbol` | `/api/v1/search?symbol=` |
| `opengrok_search_file_path` | `filepath` | `/api/v1/search?path=` |
| `opengrok_search_by_type` | `fileType` | `/api/v1/search?type=` |
| `opengrok_get_file_content` | `filepath` | `/source/raw/{project}/{path}` |
| `opengrok_list_projects` | *(none)* | `/api/v1/projects` |

### Common search parameters

Every search tool accepts these alongside its primary field:

| Param | Type | Default | Wire mapping |
|-------|------|---------|--------------|
| `project` | `string \| string[]` | required | Repeated `projects=` per name (handled by `appendProjects`) |
| `maxResults` | `1..500` int | `20` | `maxresults=` |
| `start` | `>=0` int | omitted (server default 0) | `start=` — only sent when explicitly provided, so legacy single-page calls remain byte-identical on the wire |
| `pathFilter` | `string` | omitted | `path=` (Lucene path expression). NOT exposed on `opengrok_search_file_path` (would shadow `filepath`) |

Empty-string params (`""`) are dropped client-side in `buildSearchQuery` — never sent. This is uniform across `full`/`def`/`symbol`/`path`/`type`.

### Result formatting

`formatSearchResponse(data, fileOrder?)` is the single rendering pipeline:

1. **Header** — `Found N result(s) in Tms (results startDocument–endDocument):` (or `No results found.` for empty).
2. **File ordering** — when `fileOrder` is provided (Phase 2G reranker), iterate it first; remaining files appended in response order. Empty / undefined `fileOrder` preserves response order.
3. **Near-duplicate collapse** — first pass counts cleaned+trimmed line text across the whole response; lines with `count >= 3 AND length >= 25` show once (annotated `[duplicated N× — first at file:line]`) and the other files emit a `(N line(s) identical to file:line hidden)` placeholder.
4. **Path-relevance reranking** — `pathMatchScore(filePath, query)` weights query-token matches in the path; threaded by `search()` only for `full_text` / `definition` / `symbol` (not for `file_path` or `by_type`). Currently unconditional when query text exists; an opt-out parameter is on the roadmap (`improvement-ideas.txt` lines 178-189).

### `opengrok_get_file_content`

Single-project (`project: string`, not the multi-project union). `filepath` runs through `validateFilepath` which strips leading `/` and rejects bare `..` segments client-side. Optional `startLine` / `endLine` (1-based, inclusive) slice via `formatFileContent` — `endLine` past EOF is clamped silently; `startLine > total` returns the header-only EOF marker; `startLine > endLine` throws. axios is configured with `responseType: "text"` and `transformResponse: [(d) => d]` to defeat auto-JSON-parsing of file bodies.

### Unverified HTTP assumptions

Three inline `// UNVERIFIED:` comments mark behaviors validated only against the reference OpenGrok deployment, not exhaustively spec'd:

- `src/index.ts:62` — `appendProjects` uses repeated `projects=` (vs. comma-separated). If multi-project searches return wrong results on a different OpenGrok build, swap to `qp.set("projects", list.join(","))`.
- `src/index.ts:351` — `/source/raw/<project>/<path>` is the conventional raw-file endpoint. Some deployments mount under a different prefix or disable raw access; failures surface verbatim via the Phase 1E error-body inclusion.
- `src/index.ts:377` — path-relevance rerank is a heuristic, not a measured improvement. Trivially reversible by removing the `rerankQuery` arg from the three search handlers.

## Error handling convention

Tool handlers are wrapped in `runTool(...)`, which catches any throw and returns `{ isError: true, content: [{ type: "text", text: ... }] }` per the MCP convention. `formatError` discriminates axios errors (HTTP response, `ECONNABORTED` timeout, other network codes) from generic errors so the LLM gets readable messages instead of stack traces. Any new tool must be wired through `runTool`.

## Things not to do

- Do not add new axios clients — reuse the module-level `client`.
- Do not use `process.exit()` at module load. Throw from `createClient()` so tests can import the module safely.
- Do not remove the `main()` guard at the bottom of `src/index.ts` — importing the module must not start the server. Tests depend on this.
- Do not edit `dist/` by hand; it is generated.
- Do not add tools that return raw stringly-typed blobs. Route output through `formatSearchResponse` / `formatProjects` (or a similar helper) so the LLM sees consistent Markdown.
- Keep the public `CLAUDE.md` generic. Environment-specific setup notes (real hostnames, IPs, container names, internal infra details) belong in separate `CLAUDE.local.<host>.md` files so the public file stays portable across deployments.
