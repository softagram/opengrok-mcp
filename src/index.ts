#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios, { AxiosInstance } from "axios";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_RESULTS = 20;
const MAX_RESULTS_CAP = 500;

let client: AxiosInstance;

function createClient(): AxiosInstance {
  const url = process.env.OPENGROK_URL;
  if (!url) {
    throw new Error("OPENGROK_URL environment variable is required");
  }
  const username = process.env.OPENGROK_USERNAME;
  const password = process.env.OPENGROK_PASSWORD;

  const instance = axios.create({
    baseURL: url,
    timeout: 30000,
    headers: {
      // X-Forwarded-For: 127.0.0.1 lets this server bypass oauth2-proxy-style
      // reverse proxies that whitelist localhost — useful when reaching OpenGrok
      // through an SSH tunnel from the proxy host. Harmless when OpenGrok is
      // exposed directly. See the README "Configure" section for the full rationale.
      "X-Forwarded-For": "127.0.0.1",
    },
  });

  if (username && password) {
    instance.defaults.auth = { username, password };
  }

  return instance;
}

export interface OpenGrokSearchResponse {
  time: number;
  resultCount: number;
  startDocument: number;
  endDocument: number;
  results: Record<string, Array<{ line: string; lineNumber: string; tag: string | null }>>;
}

interface OpenGrokSearchParams {
  project: string;
  maxResults?: number;
  start?: number;
  full?: string;
  def?: string;
  symbol?: string;
  path?: string;
  type?: string;
}

export function formatSearchResponse(data: OpenGrokSearchResponse): string {
  if (data.resultCount === 0) {
    return "No results found.";
  }

  const lines: string[] = [];
  lines.push(
    `Found ${data.resultCount} result(s) in ${data.time}ms (results ${data.startDocument}–${data.endDocument}):\n`
  );

  for (const [filePath, matches] of Object.entries(data.results)) {
    lines.push(`## ${filePath}`);
    for (const match of matches) {
      const cleanLine = match.line
        .replace(/<b>/g, "**")
        .replace(/<\/b>/g, "**")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"');
      const tag = match.tag ? ` (${match.tag})` : "";
      lines.push(`  Line ${match.lineNumber}${tag}: ${cleanLine.trim()}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function formatProjects(projects: string[]): string {
  if (projects.length === 0) {
    return "No projects found.";
  }

  const sorted = [...projects].sort();
  const lines: string[] = [];
  lines.push(`Found ${sorted.length} project(s):\n`);
  for (const name of sorted) {
    lines.push(`- ${name}`);
  }
  return lines.join("\n");
}

const ERROR_BODY_CAP = 500;

export function snippetFromBody(body: unknown): string | null {
  if (body === null || body === undefined) {
    return null;
  }
  if (Buffer.isBuffer(body)) {
    return `<binary, ${body.length} bytes>`;
  }
  let text: string;
  if (typeof body === "string") {
    text = body;
  } else {
    try {
      text = JSON.stringify(body);
    } catch {
      text = String(body);
    }
  }
  if (text.length > ERROR_BODY_CAP) {
    const remainder = text.length - ERROR_BODY_CAP;
    return `${text.slice(0, ERROR_BODY_CAP)}… (+${remainder} chars)`;
  }
  return text;
}

export function formatError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    if (err.response) {
      const base = `OpenGrok request failed: HTTP ${err.response.status} ${err.response.statusText}`;
      const snippet = snippetFromBody(err.response.data);
      return snippet === null ? base : `${base}\nResponse body: ${snippet}`;
    }
    if (err.code === "ECONNABORTED") {
      return "OpenGrok request timed out";
    }
    if (err.code) {
      return `OpenGrok request failed: ${err.code} — ${err.message}`;
    }
  }
  return `OpenGrok request failed: ${err instanceof Error ? err.message : String(err)}`;
}

async function runTool(work: () => Promise<string>) {
  try {
    const text = await work();
    return { content: [{ type: "text" as const, text }] };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: formatError(err) }],
    };
  }
}

async function search(params: OpenGrokSearchParams): Promise<string> {
  const {
    project,
    maxResults = DEFAULT_MAX_RESULTS,
    start,
    full,
    def,
    symbol,
    path,
    type,
  } = params;

  const queryParams = new URLSearchParams({
    projects: project,
    maxresults: String(maxResults),
  });
  if (start !== undefined) queryParams.set("start", String(start));
  if (full !== undefined) queryParams.set("full", full);
  if (def !== undefined) queryParams.set("def", def);
  if (symbol !== undefined) queryParams.set("symbol", symbol);
  if (path !== undefined) queryParams.set("path", path);
  if (type !== undefined) queryParams.set("type", type);

  const response = await client.get<OpenGrokSearchResponse>(
    `/api/v1/search?${queryParams.toString()}`
  );

  return formatSearchResponse(response.data);
}

const server = new McpServer({
  name: "opengrok",
  version: "1.0.0",
});

const projectParam = z
  .string()
  .describe("Name of the OpenGrok project to search in");

const maxResultsParam = z
  .number()
  .int()
  .min(1)
  .max(MAX_RESULTS_CAP)
  .optional()
  .describe(
    `Maximum number of results to return (default ${DEFAULT_MAX_RESULTS}, hard cap ${MAX_RESULTS_CAP})`
  );

const startParam = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe(
    "Zero-based offset of the first result to return (for paginating past maxResults)"
  );

server.tool(
  "opengrok_search_full_text",
  "Search text inside files in OpenGrok",
  {
    project: projectParam,
    query: z.string().describe("The text string to search for inside files"),
    maxResults: maxResultsParam,
    start: startParam,
  },
  async ({ project, query, maxResults, start }) =>
    runTool(() => search({ project, full: query, maxResults, start }))
);

server.tool(
  "opengrok_search_definition",
  "Search for definitions (e.g., function or class names) in OpenGrok",
  {
    project: projectParam,
    definition: z.string().describe("Definition name to search for"),
    maxResults: maxResultsParam,
    start: startParam,
  },
  async ({ project, definition, maxResults, start }) =>
    runTool(() => search({ project, def: definition, maxResults, start }))
);

server.tool(
  "opengrok_search_symbol",
  "Search for references to a symbol in OpenGrok",
  {
    project: projectParam,
    symbol: z.string().describe("Symbol name to search for references"),
    maxResults: maxResultsParam,
    start: startParam,
  },
  async ({ project, symbol, maxResults, start }) =>
    runTool(() => search({ project, symbol, maxResults, start }))
);

server.tool(
  "opengrok_search_file_path",
  "Search for files by path in OpenGrok",
  {
    project: projectParam,
    filepath: z.string().describe("Path or filename to search for"),
    maxResults: maxResultsParam,
    start: startParam,
  },
  async ({ project, filepath, maxResults, start }) =>
    runTool(() => search({ project, path: filepath, maxResults, start }))
);

server.tool(
  "opengrok_search_by_type",
  "Search for files by type (e.g., python, cpp, java) in OpenGrok",
  {
    project: projectParam,
    fileType: z
      .string()
      .describe("File type to search for (e.g., python, cpp, java)"),
    maxResults: maxResultsParam,
    start: startParam,
  },
  async ({ project, fileType, maxResults, start }) =>
    runTool(() => search({ project, type: fileType, maxResults, start }))
);

server.tool(
  "opengrok_list_projects",
  "List all available projects in OpenGrok",
  {},
  async () =>
    runTool(async () => {
      const response = await client.get<string[]>("/api/v1/projects");
      return formatProjects(response.data);
    })
);

async function main() {
  client = createClient();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only start the server when this file is executed directly. When imported
// by tests, `process.argv[1]` points at the test runner, not this module,
// so main() stays dormant and the module can be read for its exports.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
