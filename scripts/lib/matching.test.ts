import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { scopeMatches, wordBoundaryMatch } from "./matching.ts";

// ---------------------------------------------------------------------------
// scopeMatches
// ---------------------------------------------------------------------------

Deno.test("scopeMatches: exact match", () => {
  assertEquals(scopeMatches("auth", "auth"), true);
});

Deno.test("scopeMatches: prefix with child", () => {
  assertEquals(scopeMatches("auth/registration", "auth"), true);
});

Deno.test("scopeMatches: deep prefix", () => {
  assertEquals(scopeMatches("auth/registration/flow", "auth"), true);
});

Deno.test("scopeMatches: multi-segment exact", () => {
  assertEquals(scopeMatches("auth/registration", "auth/registration"), true);
});

Deno.test("scopeMatches: substring but not prefix - rejects oauth", () => {
  assertEquals(scopeMatches("oauth/provider", "auth"), false);
});

Deno.test("scopeMatches: contains but not prefix - rejects unauthorized", () => {
  assertEquals(scopeMatches("unauthorized", "auth"), false);
});

Deno.test("scopeMatches: case insensitive", () => {
  assertEquals(scopeMatches("Auth/Registration", "auth"), true);
  assertEquals(scopeMatches("auth/registration", "AUTH"), true);
});

Deno.test("scopeMatches: no false positive on partial segment", () => {
  assertEquals(scopeMatches("authentication", "auth"), false);
});

// ---------------------------------------------------------------------------
// wordBoundaryMatch
// ---------------------------------------------------------------------------

Deno.test("wordBoundaryMatch: word at start of text", () => {
  assertEquals(wordBoundaryMatch("Redis pub/sub (no persistence)", "redis"), true);
});

Deno.test("wordBoundaryMatch: word in middle of text", () => {
  assertEquals(wordBoundaryMatch("use Redis for caching", "redis"), true);
});

Deno.test("wordBoundaryMatch: rejects prefix substring - jedis", () => {
  assertEquals(wordBoundaryMatch("jedis client library", "redis"), false);
});

Deno.test("wordBoundaryMatch: rejects prefix substring - predis", () => {
  assertEquals(wordBoundaryMatch("predis PHP client", "redis"), false);
});

Deno.test("wordBoundaryMatch: rejects embedded substring - redistribution", () => {
  assertEquals(wordBoundaryMatch("redistribution clause", "redis"), false);
});

Deno.test("wordBoundaryMatch: escapes regex special chars without crashing", () => {
  // Keywords with regex metacharacters don't throw
  assertEquals(wordBoundaryMatch("uses .NET framework", ".NET"), false); // \b doesn't fire around non-word chars
  assertEquals(wordBoundaryMatch("foo(bar) baz", "foo"), true);
});

Deno.test("wordBoundaryMatch: case insensitive", () => {
  assertEquals(wordBoundaryMatch("REDIS cluster mode", "redis"), true);
  assertEquals(wordBoundaryMatch("redis cluster mode", "REDIS"), true);
});
