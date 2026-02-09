import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import {
  buildRetryPrompt,
  buildSystemPrompt,
  buildUserPrompt,
} from "./prompt.ts";
import type { CommitExtract, Diagnostic } from "../types.ts";

// ---------------------------------------------------------------------------
// buildSystemPrompt
// ---------------------------------------------------------------------------

Deno.test("buildSystemPrompt: includes format spec and taxonomy", () => {
  const result = buildSystemPrompt("FORMAT SPEC HERE", "TAXONOMY HERE");

  assert(result.includes("FORMAT SPEC HERE"));
  assert(result.includes("TAXONOMY HERE"));
});

Deno.test("buildSystemPrompt: includes output rules", () => {
  const result = buildSystemPrompt("spec", "taxonomy");

  assert(result.includes("OUTPUT RULES"));
  assert(result.includes("No markdown fences"));
});

Deno.test("buildSystemPrompt: includes examples", () => {
  const result = buildSystemPrompt("spec", "taxonomy");

  assert(result.includes("Example 1"));
  assert(result.includes("Intent: enable-capability"));
  assert(result.includes("Intent: fix-defect"));
  assert(result.includes("Intent: configure-infra"));
});

// ---------------------------------------------------------------------------
// buildUserPrompt
// ---------------------------------------------------------------------------

const sampleExtract: CommitExtract = {
  hash: "abc1234def5678",
  date: "2026-01-15T10:30:00+01:00",
  author: "Alice",
  message: "fix: resolve login bug",
  stat: " src/auth.ts | 5 +++--\n src/session.ts | 3 ++-",
  shortstat: "2 files changed, 5 insertions(+), 3 deletions(-)",
};

Deno.test("buildUserPrompt: includes all extract fields", () => {
  const result = buildUserPrompt(sampleExtract);

  assert(result.includes("abc1234def5678"));
  assert(result.includes("2026-01-15T10:30:00+01:00"));
  assert(result.includes("Alice"));
  assert(result.includes("fix: resolve login bug"));
  assert(result.includes("src/auth.ts"));
  assert(result.includes("2 files changed"));
});

Deno.test("buildUserPrompt: handles empty stat gracefully", () => {
  const extract: CommitExtract = {
    ...sampleExtract,
    stat: "",
    shortstat: "",
  };
  const result = buildUserPrompt(extract);

  assert(result.includes("(no stat available)"));
  assert(result.includes("(no shortstat available)"));
});

// ---------------------------------------------------------------------------
// buildRetryPrompt
// ---------------------------------------------------------------------------

Deno.test("buildRetryPrompt: includes validation errors", () => {
  const errors: readonly Diagnostic[] = [
    { severity: "error", rule: "intent-required", message: "Missing required trailer: Intent" },
    { severity: "warning", rule: "scope-format", message: 'Scope "backend" should use domain/module format' },
  ];

  const result = buildRetryPrompt(sampleExtract, errors);

  assert(result.includes("VALIDATION ERRORS"));
  assert(result.includes("intent-required"));
  assert(result.includes("scope-format"));
  assert(result.includes("[error]"));
  assert(result.includes("[warning]"));
});

Deno.test("buildRetryPrompt: includes original commit info", () => {
  const errors: readonly Diagnostic[] = [
    { severity: "error", rule: "intent-required", message: "Missing Intent" },
  ];

  const result = buildRetryPrompt(sampleExtract, errors);

  assert(result.includes("abc1234def5678"));
  assert(result.includes("fix: resolve login bug"));
});

Deno.test("buildRetryPrompt: instructs to fix and output only corrected message", () => {
  const errors: readonly Diagnostic[] = [
    { severity: "error", rule: "intent-required", message: "Missing Intent" },
  ];

  const result = buildRetryPrompt(sampleExtract, errors);

  assert(result.includes("Fix them"));
  assert(result.includes("output only the corrected commit message"));
});

// ---------------------------------------------------------------------------
// Prompt structure
// ---------------------------------------------------------------------------

Deno.test("buildUserPrompt: starts with clear instruction", () => {
  const result = buildUserPrompt(sampleExtract);

  assert(result.startsWith("Rewrite this commit"));
});

Deno.test("buildSystemPrompt: assigns clear role", () => {
  const result = buildSystemPrompt("spec", "taxonomy");
  const firstLine = result.split("\n")[0];

  assertEquals(firstLine, "You are a commit message formatter. Your job is to rewrite git commit messages into the structured format defined below.");
});
