import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  formatSearchResponse,
  formatProjects,
  formatError,
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
  assert.match(output, /Found 1 result\(s\) in 12ms:/);
  assert.match(output, /## src\/foo\.py/);
  assert.match(output, /Line 42: if x < y && z > 0: return "ok"/);
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
