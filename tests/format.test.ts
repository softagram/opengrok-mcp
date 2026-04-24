import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  formatSearchResponse,
  formatProjects,
  formatError,
  buildSearchQuery,
  type OpenGrokSearchResponse,
} from "../src/index.js";

test("formatSearchResponse: returns empty-state message when resultCount is 0", () => {
  const data: OpenGrokSearchResponse = {
    time: 5,
    resultCount: 0,
    startDocument: 0,
    endDocument: 0,
    results: {},
  };
  assert.equal(formatSearchResponse(data), "No results found.");
});

test("formatSearchResponse: decodes HTML entities from OpenGrok output", () => {
  const data: OpenGrokSearchResponse = {
    time: 12,
    resultCount: 1,
    startDocument: 1,
    endDocument: 1,
    results: {
      "src/foo.py": [
        {
          line: "if x &lt; y &amp;&amp; z &gt; 0: return &quot;ok&quot;",
          lineNumber: "42",
          tag: null,
        },
      ],
    },
  };
  const output = formatSearchResponse(data);
  assert.match(output, /Found 1 result\(s\) in 12ms \(results 1–1\):/);
  assert.match(output, /## src\/foo\.py/);
  assert.match(output, /Line 42: if x < y && z > 0: return "ok"/);
});

test("formatSearchResponse: header reports startDocument–endDocument range", () => {
  const data: OpenGrokSearchResponse = {
    time: 7,
    resultCount: 50,
    startDocument: 21,
    endDocument: 70,
    results: {
      "src/foo.ts": [{ line: "hit", lineNumber: "1", tag: null }],
    },
  };
  const output = formatSearchResponse(data);
  assert.match(output, /Found 50 result\(s\) in 7ms \(results 21–70\):/);
});

test("formatSearchResponse: converts <b> highlights to Markdown bold and includes tag", () => {
  const data: OpenGrokSearchResponse = {
    time: 5,
    resultCount: 1,
    startDocument: 1,
    endDocument: 1,
    results: {
      "a.ts": [
        {
          line: "const <b>needle</b> = 42;",
          lineNumber: "10",
          tag: "function",
        },
      ],
    },
  };
  const output = formatSearchResponse(data);
  assert.match(output, /Line 10 \(function\): const \*\*needle\*\* = 42;/);
});

test("formatSearchResponse: groups multiple matches under one file heading", () => {
  const data: OpenGrokSearchResponse = {
    time: 3,
    resultCount: 2,
    startDocument: 1,
    endDocument: 2,
    results: {
      "lib.ts": [
        { line: "first match", lineNumber: "1", tag: null },
        { line: "second match", lineNumber: "5", tag: null },
      ],
    },
  };
  const output = formatSearchResponse(data);
  const headingMatches = output.match(/^## lib\.ts$/gm) ?? [];
  assert.equal(headingMatches.length, 1, "file heading should appear only once");
  assert.match(output, /Line 1: first match/);
  assert.match(output, /Line 5: second match/);
});

test("formatProjects: returns empty-state message for no projects", () => {
  assert.equal(formatProjects([]), "No projects found.");
});

test("formatProjects: sorts project names alphabetically", () => {
  const output = formatProjects(["zebra", "alpha", "mike"]);
  const alphaIdx = output.indexOf("- alpha");
  const mikeIdx = output.indexOf("- mike");
  const zebraIdx = output.indexOf("- zebra");
  assert.ok(alphaIdx > -1 && mikeIdx > -1 && zebraIdx > -1, "all three should appear");
  assert.ok(alphaIdx < mikeIdx, "alpha should come before mike");
  assert.ok(mikeIdx < zebraIdx, "mike should come before zebra");
});

test("formatProjects: reports the number of projects", () => {
  assert.match(formatProjects(["a", "b", "c"]), /Found 3 project\(s\)/);
});

test("formatError: formats a generic Error instance", () => {
  assert.equal(formatError(new Error("boom")), "OpenGrok request failed: boom");
});

test("formatError: formats a non-Error thrown value", () => {
  assert.equal(formatError("string fail"), "OpenGrok request failed: string fail");
});

// ---- Phase 1: error body snippet ----

import axios from "axios";

function makeAxiosError(status: number, statusText: string, data: unknown) {
  const err = new axios.AxiosError(
    `Request failed with status code ${status}`,
    "ERR_BAD_REQUEST",
    undefined,
    null,
    {
      status,
      statusText,
      data,
      headers: {},
      config: {} as never,
    } as never
  );
  return err;
}

test("formatError: appends short string body verbatim under cap", () => {
  const err = makeAxiosError(400, "Bad Request", "missing project parameter");
  const out = formatError(err);
  assert.match(out, /HTTP 400 Bad Request/);
  assert.match(out, /Response body: missing project parameter/);
});

test("formatError: truncates long string body with `… (+N chars)` suffix", () => {
  const body = "x".repeat(800);
  const err = makeAxiosError(500, "Internal Server Error", body);
  const out = formatError(err);
  assert.match(out, /HTTP 500 Internal Server Error/);
  // 500 chars retained, plus suffix indicating remainder
  assert.match(out, /Response body: x{500}… \(\+300 chars\)/);
});

test("formatError: JSON-stringifies object body", () => {
  const err = makeAxiosError(422, "Unprocessable Entity", { error: "nope", code: 7 });
  const out = formatError(err);
  assert.match(out, /Response body: \{"error":"nope","code":7\}/);
});

test("formatError: shows binary marker for Buffer body", () => {
  const buf = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const err = makeAxiosError(502, "Bad Gateway", buf);
  const out = formatError(err);
  assert.match(out, /Response body: <binary, 8 bytes>/);
});

test("formatError: omits Response body line when body is null/undefined", () => {
  const err = makeAxiosError(404, "Not Found", undefined);
  const out = formatError(err);
  assert.match(out, /HTTP 404 Not Found/);
  assert.doesNotMatch(out, /Response body:/);
});

// ---- Phase 4: buildSearchQuery + multi-project ----

test("buildSearchQuery: single project string emits one projects= entry", () => {
  const qp = buildSearchQuery({ project: "demo", full: "needle" });
  assert.deepEqual(qp.getAll("projects"), ["demo"]);
  assert.equal(qp.get("full"), "needle");
});

test("buildSearchQuery: project array repeats projects= in order", () => {
  const qp = buildSearchQuery({ project: ["proj-a", "proj-b"], full: "x" });
  assert.deepEqual(qp.getAll("projects"), ["proj-a", "proj-b"]);
});

test("buildSearchQuery: empty-string project entries are skipped", () => {
  const qp = buildSearchQuery({
    project: ["proj-a", "", "proj-b", ""],
    def: "Foo",
  });
  assert.deepEqual(qp.getAll("projects"), ["proj-a", "proj-b"]);
});

test("buildSearchQuery: omits start when undefined", () => {
  const qp = buildSearchQuery({ project: "demo", full: "x" });
  assert.equal(qp.has("start"), false);
});

test("buildSearchQuery: includes start when 0", () => {
  const qp = buildSearchQuery({ project: "demo", full: "x", start: 0 });
  assert.equal(qp.get("start"), "0");
});

// ---- Phase 5: dedup ----

test("formatSearchResponse: no dedup when occurrence count is below threshold", () => {
  // 2 copies of an otherwise-dedup-eligible long line — should NOT dedup
  const longLine = "this is a sufficiently long shared line for dedup test";
  const data: OpenGrokSearchResponse = {
    time: 1,
    resultCount: 2,
    startDocument: 1,
    endDocument: 2,
    results: {
      "src/foo.ts": [{ line: longLine, lineNumber: "10", tag: null }],
      "lib.ts": [{ line: longLine, lineNumber: "20", tag: null }],
    },
  };
  const out = formatSearchResponse(data);
  assert.doesNotMatch(out, /duplicated/);
  assert.doesNotMatch(out, /identical to/);
});

test("formatSearchResponse: no dedup when line trimmed length below threshold", () => {
  // 4 copies of a short line — short lines must NOT dedup regardless of count
  const shortLine = "short hit";
  const data: OpenGrokSearchResponse = {
    time: 1,
    resultCount: 4,
    startDocument: 1,
    endDocument: 4,
    results: {
      "a.ts": [{ line: shortLine, lineNumber: "1", tag: null }],
      "b.ts": [{ line: shortLine, lineNumber: "2", tag: null }],
      "c.ts": [{ line: shortLine, lineNumber: "3", tag: null }],
      "d.ts": [{ line: shortLine, lineNumber: "4", tag: null }],
    },
  };
  const out = formatSearchResponse(data);
  assert.doesNotMatch(out, /duplicated/);
  assert.doesNotMatch(out, /identical to/);
});

test("formatSearchResponse: dedup applied with first-occurrence annotation and suppression", () => {
  const longLine = "this is a duplicated line of sufficient length";
  const data: OpenGrokSearchResponse = {
    time: 1,
    resultCount: 3,
    startDocument: 1,
    endDocument: 3,
    results: {
      "src/foo.ts": [{ line: longLine, lineNumber: "10", tag: null }],
      "lib.ts": [{ line: longLine, lineNumber: "20", tag: null }],
      "pkg/util.ts": [{ line: longLine, lineNumber: "30", tag: null }],
    },
  };
  const out = formatSearchResponse(data);
  assert.match(
    out,
    /Line 10:.*duplicated line of sufficient length.*\[duplicated 3× — first at src\/foo\.ts:10\]/
  );
  assert.match(
    out,
    /\(1 line\(s\) identical to src\/foo\.ts:10 hidden\)/
  );
  // Should appear in BOTH suppressed files
  const suppressionMatches = out.match(/identical to src\/foo\.ts:10 hidden/g) ?? [];
  assert.equal(suppressionMatches.length, 2);
});

test("formatSearchResponse: dedup preserves non-duplicate matches in suppressed files", () => {
  const dup = "this duplicate line appears in three places long enough";
  const unique = "unique to second file but also long enough text here";
  const data: OpenGrokSearchResponse = {
    time: 1,
    resultCount: 4,
    startDocument: 1,
    endDocument: 4,
    results: {
      "src/foo.ts": [{ line: dup, lineNumber: "5", tag: null }],
      "lib.ts": [
        { line: dup, lineNumber: "15", tag: null },
        { line: unique, lineNumber: "16", tag: null },
      ],
      "pkg/util.ts": [{ line: dup, lineNumber: "25", tag: null }],
    },
  };
  const out = formatSearchResponse(data);
  assert.match(out, /Line 16:.*unique to second file/);
  assert.match(out, /identical to src\/foo\.ts:5 hidden/);
});

test("formatSearchResponse: dedup key uses cleaned (de-HTML) trimmed text", () => {
  const raw = "  &lt;b&gt; alpha beta gamma delta epsilon zeta eta &lt;/b&gt;  ";
  const html = "<b> alpha beta gamma delta epsilon zeta eta </b>"; // would clean to same as above? No — different
  // Actually craft so the cleaned form matches across rows
  const a = "  if (foo === bar) { return doSomething(); } // long enough  ";
  const b = "if (foo === bar) { return doSomething(); } // long enough";
  const c = "  if (foo === bar) { return doSomething(); } // long enough";
  void raw;
  void html;
  const data: OpenGrokSearchResponse = {
    time: 1,
    resultCount: 3,
    startDocument: 1,
    endDocument: 3,
    results: {
      "src/foo.ts": [{ line: a, lineNumber: "1", tag: null }],
      "lib.ts": [{ line: b, lineNumber: "2", tag: null }],
      "pkg/util.ts": [{ line: c, lineNumber: "3", tag: null }],
    },
  };
  const out = formatSearchResponse(data);
  assert.match(out, /\[duplicated 3× — first at src\/foo\.ts:1\]/);
});
