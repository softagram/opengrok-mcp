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

All tools are namespaced with the `opengrok_` prefix (to avoid collisions with other MCP servers or legacy versions). Search tools take `project` and an optional `maxResults` integer in the range `1..500`, defaulting to 20. Each handler translates its schema field into the OpenGrok query parameter inside the closure.

| Tool | Schema field | OpenGrok query param |
|------|-------------|---------------------|
| `opengrok_search_full_text` | `query` | `full` |
| `opengrok_search_definition` | `definition` | `def` |
| `opengrok_search_symbol` | `symbol` | `symbol` |
| `opengrok_search_file_path` | `filepath` | `path` |
| `opengrok_search_by_type` | `fileType` | `type` |
| `opengrok_list_projects` | *(none)* | *(different endpoint)* |

## Error handling convention

Tool handlers are wrapped in `runTool(...)`, which catches any throw and returns `{ isError: true, content: [{ type: "text", text: ... }] }` per the MCP convention. `formatError` discriminates axios errors (HTTP response, `ECONNABORTED` timeout, other network codes) from generic errors so the LLM gets readable messages instead of stack traces. Any new tool must be wired through `runTool`.

## Things not to do

- Do not add new axios clients — reuse the module-level `client`.
- Do not use `process.exit()` at module load. Throw from `createClient()` so tests can import the module safely.
- Do not remove the `main()` guard at the bottom of `src/index.ts` — importing the module must not start the server. Tests depend on this.
- Do not edit `dist/` by hand; it is generated.
- Do not add tools that return raw stringly-typed blobs. Route output through `formatSearchResponse` / `formatProjects` (or a similar helper) so the LLM sees consistent Markdown.
- Keep the public `CLAUDE.md` generic. Environment-specific setup notes (real hostnames, IPs, container names, internal infra details) belong in separate `CLAUDE.local.<host>.md` files so the public file stays portable across deployments.
