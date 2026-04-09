# OpenGrok MCP

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that exposes [OpenGrok](https://oracle.github.io/opengrok/) code search to LLM agents. Point it at any OpenGrok instance and your agent can search across every indexed repository without cloning anything locally.

> **This is an stdio MCP server.** It is not a daemon and not an HTTP service. It is launched as a child process by an MCP client (Claude Code, VS Code MCP, Cursor, etc.) and speaks JSON-RPC over stdin/stdout for the lifetime of that client session. You do not run it yourself — the client starts and stops it. See [Transport](#transport-stdio) below.

## How it works

OpenGrok pre-indexes large multi-repository codebases and serves a fast search API backed by Lucene and ctags-style symbol extraction. This server wraps that API as a small set of MCP tools, so an agent can answer questions like *"where is `validateToken` defined?"* or *"which files import `pandas`?"* across dozens of repos in a single call — without grepping checkout trees or context-switching between projects.

### Tools

All search tools take a `project` parameter (the OpenGrok project name — use `opengrok_list_projects` to discover what's available).

| Tool | Purpose | Typical use |
|------|---------|-------------|
| `opengrok_list_projects` | List every indexed project on the OpenGrok instance | Discover what's searchable before drilling in |
| `opengrok_search_full_text` | Free-text search inside file contents | Find log messages, error strings, comments, config values |
| `opengrok_search_definition` | Find where a function, class, or method is **defined** | *"Where is `parseConfig` defined?"* — jumps straight to declarations, not call sites |
| `opengrok_search_symbol` | Find **references** to a symbol | *"What calls `parseConfig`?"* — locates usages across the whole project |
| `opengrok_search_file_path` | Find files by path or filename | *"Find every `Dockerfile` in the monorepo"* |
| `opengrok_search_by_type` | Filter by file type (`python`, `cpp`, `java`, …) | Narrow a search to a specific language |

All search tools (everything except `opengrok_list_projects`) additionally accept an optional `maxResults` parameter — an integer between 1 and 500, defaulting to 20. Raise it when the agent needs broader results; the default keeps tool output compact for the common case.

### Why this is useful for agents

- **One search across many repos.** OpenGrok indexes entire portfolios — the agent can survey *"how do we handle retries everywhere?"* in a single query instead of cloning N repos one by one.
- **Definition vs. reference distinction.** Unlike grep, `opengrok_search_definition` and `opengrok_search_symbol` use OpenGrok's symbol index, so the agent doesn't have to disambiguate raw string matches.
- **Pre-indexed → fast.** Searches return in milliseconds even on million-line codebases.
- **No checkout required.** The agent never needs to fetch source code locally just to look around.

Results are returned as compact Markdown with file paths, line numbers, and matching lines, ready for the LLM to read.

### Transport (stdio)

The MCP spec defines two transports: **stdio** (process-local, JSON-RPC over stdin/stdout) and **HTTP/SSE** (network). This server implements **only stdio** — see the single `StdioServerTransport` in `src/index.ts`. Concretely:

- **The MCP client owns the process lifecycle.** When the client starts, it spawns `node dist/index.js` (or whatever `command` you configure). When the client exits, the child is killed. There is no port, no socket, and no long-lived daemon.
- **One server instance per client session.** Each editor window / Claude Code session gets its own child process. There is no sharing or connection pooling.
- **Running `npm start` manually is only useful as a smoke test.** It will sit silently waiting for a JSON-RPC handshake on stdin that will never come unless you paste one by hand. This is expected — stdio MCP servers are not meant to be run interactively.
- **Do not put this behind a reverse proxy, systemd, PM2, or a container orchestrator.** Those are patterns for network servers. For stdio, all of that is handled by whoever launches the MCP client.
- **Environment variables are passed by the client**, not by a shell you control. Your MCP client config (see [Register with your MCP client](#register-with-your-mcp-client)) is where `OPENGROK_URL` etc. have to be set.

If at some point this server grows an HTTP/SSE transport, that will be a separate, additive feature — the stdio mode is the canonical one.

## Installation

### Prerequisites
- Node.js 18 or newer
- Network access to a running OpenGrok instance exposing `/api/v1/...`

### Build from source
```sh
git clone git@github.com:softagram/opengrok-mcp.git
cd opengrok-mcp
npm install
npm run build
```

### Configure

The server is configured via environment variables:

| Variable | Required | Purpose |
|----------|----------|---------|
| `OPENGROK_URL` | yes | Base URL of the OpenGrok instance, e.g. `https://opengrok.example.com` (no trailing `/source`) |
| `OPENGROK_USERNAME` | no | HTTP basic auth username, if your OpenGrok instance requires it |
| `OPENGROK_PASSWORD` | no | HTTP basic auth password |

> **Note:** the server always sends an `X-Forwarded-For: 127.0.0.1` header. This is intentional — it lets the server bypass `oauth2-proxy`-style reverse proxies that whitelist localhost when paired with an SSH tunnel from the proxy host. If your OpenGrok is exposed directly, the header is harmless.

### Register with your MCP client

Because this is a stdio server (see [Transport](#transport-stdio)), "installation" really just means telling your MCP client *how to spawn it*. There is no service to start — the client will launch `node dist/index.js` on demand and kill it when the session ends.

For Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "opengrok": {
      "command": "node",
      "args": ["/absolute/path/to/opengrok-mcp/dist/index.js"],
      "env": {
        "OPENGROK_URL": "https://opengrok.example.com"
      }
    }
  }
}
```

For VS Code's MCP integration (`settings.json`):

```json
{
  "mcp": {
    "servers": {
      "opengrok": {
        "command": "node",
        "args": ["/absolute/path/to/opengrok-mcp/dist/index.js"],
        "env": {
          "OPENGROK_URL": "https://opengrok.example.com"
        }
      }
    }
  }
}
```

## Contributing

Contributions are welcome — bug fixes, new tools, better result formatting, tests, and CI setup are all good areas.

### Project layout

```
src/index.ts     # entire server: tool definitions + HTTP client (single file, ~170 lines)
tsconfig.json    # strict TypeScript, ES2020, ESM
package.json     # build = tsc + chmod, start = node dist/index.js
```

The codebase is intentionally tiny. New tools should be added as additional `server.tool(...)` registrations in `src/index.ts`, following the existing zod-validated pattern.

### Local development

```sh
npm install
npm run build    # tsc + chmod +x dist/*.js
npm start        # node dist/index.js — speaks MCP over stdio
npm test         # run the unit test suite
```

`npm start` will appear to hang — that's correct. It's waiting for a JSON-RPC handshake on stdin from an MCP client (see [Transport](#transport-stdio)). To actually exercise the server, register it with an MCP client (Claude Code, VS Code, Cursor, etc.) and call the tools from there. The client will handle spawning, stdin/stdout wiring, and shutdown.

### Coding conventions

- TypeScript `strict: true` — no `any` escape hatches.
- Tool inputs are validated with `zod`. Every new tool needs a schema describing each parameter, with `.describe(...)` text — those descriptions are surfaced to the LLM and matter for tool selection.
- HTTP requests go through the shared `axios` client. Don't open new clients ad-hoc.
- Keep `formatSearchResponse` in sync with OpenGrok's response shape — OpenGrok emits minimal HTML markup (`<b>`, `&lt;`, …) that needs decoding before the result reaches the LLM.

### Pull requests

- Branch off `main` and open PRs against `main`.
- Describe the user-visible behavior change, not just the diff.
- If you add or change a tool, include an example of the tool's output in the PR description.
- Tests live in `tests/` and run with `npm test`. They use [`tsx`](https://tsx.is) + Node's built-in `node:test` runner — no Jest/Vitest dependency. Add tests for any new formatter or pure helper.
- The repo has no CI pipeline yet — a PR that introduces one (GitHub Actions running `npm run build && npm test`) is welcome.
