import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import {
  buildAnalyzePrompt,
  buildBridgePrompt,
  buildFollowUpPrompt,
  buildSummarizePrompt,
  getEffectiveSubcallLimits,
  type LlmPromptSignals,
  parseAnalyzeResponse,
  parseFollowUpResponse,
} from "./rlm-subcalls.ts";

// ---------------------------------------------------------------------------
// parseAnalyzeResponse
// ---------------------------------------------------------------------------

const VALID_SCOPES = new Set([
  "auth",
  "auth/login",
  "hooks",
  "parser",
  "graph",
]);

Deno.test("parseAnalyzeResponse: valid JSON returns parsed signals", () => {
  const text =
    '{"scopes": ["auth", "hooks"], "intents": ["fix-defect"], "keywords": ["login"]}';
  const result = parseAnalyzeResponse(text, VALID_SCOPES);

  assertEquals(result.scopes, ["auth", "hooks"]);
  assertEquals(result.intents, ["fix-defect"]);
  assertEquals(result.keywords, ["login"]);
});

Deno.test("parseAnalyzeResponse: filters out invalid scopes", () => {
  const text =
    '{"scopes": ["auth", "nonexistent", "hooks"], "intents": [], "keywords": []}';
  const result = parseAnalyzeResponse(text, VALID_SCOPES);

  assertEquals(result.scopes, ["auth", "hooks"]);
});

Deno.test("parseAnalyzeResponse: filters out invalid intents", () => {
  const text =
    '{"scopes": [], "intents": ["fix-defect", "not-real", "restructure"], "keywords": []}';
  const result = parseAnalyzeResponse(text, VALID_SCOPES);

  assertEquals(result.intents, ["fix-defect", "restructure"]);
});

Deno.test("parseAnalyzeResponse: caps scopes at 5", () => {
  const manyScopes =
    '{"scopes": ["auth", "auth/login", "hooks", "parser", "graph", "auth"], "intents": [], "keywords": []}';
  const result = parseAnalyzeResponse(manyScopes, VALID_SCOPES);

  assert(result.scopes.length <= 5);
});

Deno.test("parseAnalyzeResponse: caps intents at 2", () => {
  const text =
    '{"scopes": [], "intents": ["fix-defect", "restructure", "document"], "keywords": []}';
  const result = parseAnalyzeResponse(text, VALID_SCOPES);

  assertEquals(result.intents.length, 2);
});

Deno.test("parseAnalyzeResponse: caps keywords at 5", () => {
  const text =
    '{"scopes": [], "intents": [], "keywords": ["a", "b", "c", "d", "e", "f"]}';
  const result = parseAnalyzeResponse(text, VALID_SCOPES);

  assertEquals(result.keywords.length, 5);
});

Deno.test("parseAnalyzeResponse: invalid JSON returns empty signals", () => {
  const result = parseAnalyzeResponse("not json at all", VALID_SCOPES);

  assertEquals(result.scopes, []);
  assertEquals(result.intents, []);
  assertEquals(result.keywords, []);
});

Deno.test("parseAnalyzeResponse: missing fields returns empty arrays", () => {
  const result = parseAnalyzeResponse("{}", VALID_SCOPES);

  assertEquals(result.scopes, []);
  assertEquals(result.intents, []);
  assertEquals(result.keywords, []);
});

Deno.test("parseAnalyzeResponse: non-string values in arrays are filtered", () => {
  const text =
    '{"scopes": ["auth", 42, null], "intents": [true, "fix-defect"], "keywords": ["ok", 99]}';
  const result = parseAnalyzeResponse(text, VALID_SCOPES);

  assertEquals(result.scopes, ["auth"]);
  assertEquals(result.intents, ["fix-defect"]);
  assertEquals(result.keywords, ["ok"]);
});

Deno.test("parseAnalyzeResponse: parses fenced JSON with trailing /think", () => {
  const text =
    '```json\n{"scopes":["auth"],"intents":["fix-defect"],"keywords":["login"]}\n```\n/think';
  const result = parseAnalyzeResponse(text, VALID_SCOPES);
  assertEquals(result.scopes, ["auth"]);
  assertEquals(result.intents, ["fix-defect"]);
  assertEquals(result.keywords, ["login"]);
});

// ---------------------------------------------------------------------------
// parseFollowUpResponse
// ---------------------------------------------------------------------------

Deno.test("parseFollowUpResponse: valid queries parsed correctly", () => {
  const text =
    '{"queries": [{"scope": "auth", "intent": "fix-defect", "decidedAgainst": null}]}';
  const result = parseFollowUpResponse(text, VALID_SCOPES);

  assertEquals(result.length, 1);
  assertEquals(result[0].scope, "auth");
  assertEquals(result[0].intent, "fix-defect");
  assertEquals(result[0].decidedAgainst, null);
});

Deno.test("parseFollowUpResponse: empty queries when context sufficient", () => {
  const text = '{"queries": []}';
  const result = parseFollowUpResponse(text, VALID_SCOPES);

  assertEquals(result.length, 0);
});

Deno.test("parseFollowUpResponse: caps at 2 queries", () => {
  const text =
    '{"queries": [{"scope": "auth"}, {"scope": "hooks"}, {"scope": "parser"}]}';
  const result = parseFollowUpResponse(text, VALID_SCOPES);

  assert(result.length <= 2);
});

Deno.test("parseFollowUpResponse: filters out queries with all null fields", () => {
  const text =
    '{"queries": [{"scope": null, "intent": null, "decidedAgainst": null}, {"scope": "auth"}]}';
  const result = parseFollowUpResponse(text, VALID_SCOPES);

  assertEquals(result.length, 1);
  assertEquals(result[0].scope, "auth");
});

Deno.test("parseFollowUpResponse: invalid scope replaced with null", () => {
  const text =
    '{"queries": [{"scope": "nonexistent", "intent": "fix-defect"}]}';
  const result = parseFollowUpResponse(text, VALID_SCOPES);

  assertEquals(result.length, 1);
  assertEquals(result[0].scope, null);
  assertEquals(result[0].intent, "fix-defect");
});

Deno.test("parseFollowUpResponse: invalid intent replaced with null", () => {
  const text = '{"queries": [{"scope": "auth", "intent": "not-real"}]}';
  const result = parseFollowUpResponse(text, VALID_SCOPES);

  assertEquals(result.length, 1);
  assertEquals(result[0].scope, "auth");
  assertEquals(result[0].intent, null);
});

Deno.test("parseFollowUpResponse: decided-against query", () => {
  const text = '{"queries": [{"decidedAgainst": "redis"}]}';
  const result = parseFollowUpResponse(text, VALID_SCOPES);

  assertEquals(result.length, 1);
  assertEquals(result[0].decidedAgainst, "redis");
});

Deno.test("parseFollowUpResponse: invalid JSON returns empty array", () => {
  const result = parseFollowUpResponse("broken", VALID_SCOPES);
  assertEquals(result.length, 0);
});

Deno.test("parseFollowUpResponse: parses wrapped JSON object", () => {
  const text =
    'noise before {"queries":[{"scope":"auth","intent":"fix-defect","decidedAgainst":null}]} noise';
  const result = parseFollowUpResponse(text, VALID_SCOPES);
  assertEquals(result.length, 1);
  assertEquals(result[0].scope, "auth");
  assertEquals(result[0].intent, "fix-defect");
});

// ---------------------------------------------------------------------------
// Adaptive limits
// ---------------------------------------------------------------------------

Deno.test("getEffectiveSubcallLimits: bumps qwen3 limits", () => {
  const limits = getEffectiveSubcallLimits({
    version: 1,
    enabled: true,
    endpoint: "http://localhost:11434",
    model: "qwen3:8b",
    timeoutMs: 5000,
    maxTokens: 256,
  });

  assertEquals(limits.timeoutMs, 20000);
  assertEquals(limits.maxTokens, 1024);
});

Deno.test("getEffectiveSubcallLimits: preserves non-qwen model limits", () => {
  const limits = getEffectiveSubcallLimits({
    version: 1,
    enabled: true,
    endpoint: "http://localhost:11434",
    model: "gemma3:4b",
    timeoutMs: 5000,
    maxTokens: 256,
  });

  assertEquals(limits.timeoutMs, 5000);
  assertEquals(limits.maxTokens, 256);
});

// ---------------------------------------------------------------------------
// Prompt building: verify structure
// ---------------------------------------------------------------------------

Deno.test("buildAnalyzePrompt: includes scope keys and intent list", () => {
  const messages = buildAnalyzePrompt("fix auth login", ["auth", "hooks"]);

  assertEquals(messages.length, 2);
  assertEquals(messages[0].role, "system");
  assertEquals(messages[1].role, "user");
  assert(messages[0].content.includes("auth, hooks"));
  assert(messages[0].content.includes("fix-defect"));
  assertEquals(messages[1].content, "fix auth login");
});

Deno.test("buildFollowUpPrompt: includes prompt and context", () => {
  const messages = buildFollowUpPrompt("fix bug", "recent commits here");

  assertEquals(messages.length, 2);
  assert(messages[1].content.includes("fix bug"));
  assert(messages[1].content.includes("recent commits here"));
});

Deno.test("buildSummarizePrompt: includes task and context", () => {
  const messages = buildSummarizePrompt("add feature", "git history context");

  assertEquals(messages.length, 2);
  assert(messages[1].content.includes("add feature"));
  assert(messages[1].content.includes("git history context"));
});

Deno.test("buildBridgePrompt: includes all sections", () => {
  const messages = buildBridgePrompt(
    "deno task parse -- --scope=auth",
    "commit data",
    "decided against X",
    "hooks (3 commits)",
  );

  assertEquals(messages.length, 2);
  assert(messages[1].content.includes("deno task parse"));
  assert(messages[1].content.includes("commit data"));
  assert(messages[1].content.includes("decided against X"));
  assert(messages[1].content.includes("hooks (3 commits)"));
});

Deno.test("buildBridgePrompt: handles empty related data", () => {
  const messages = buildBridgePrompt("query", "results", "", "");

  assert(messages[1].content.includes("(none)"));
});
