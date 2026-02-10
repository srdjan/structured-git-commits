import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import type { IntentType, StructuredCommit, TrailerIndex } from "../types.ts";
import {
  applyQueryFilters,
  canUseIndex,
  filterByDecidedAgainst,
  filterByIntents,
  filterByScope,
  filterBySession,
  filterDecisionsOnly,
  queryIndexForHashes,
  type QueryParams,
} from "./query.ts";

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

const makeCommit = (overrides: Partial<StructuredCommit>): StructuredCommit => ({
  hash: "aaa111",
  date: "2025-02-08T10:00:00+00:00",
  type: "feat",
  headerScope: null,
  subject: "test commit",
  body: "",
  intent: null,
  scope: [],
  decidedAgainst: [],
  session: null,
  refs: [],
  context: null,
  breaking: null,
  raw: "",
  ...overrides,
});

const authCommit = makeCommit({
  hash: "auth001",
  intent: "enable-capability",
  scope: ["auth/registration"],
  session: "2025-02-08/passkey",
});

const oauthCommit = makeCommit({
  hash: "oauth01",
  intent: "enable-capability",
  scope: ["oauth/provider"],
  session: "2025-02-08/oauth",
});

const fixCommit = makeCommit({
  hash: "fix0001",
  intent: "fix-defect",
  scope: ["auth/login"],
  decidedAgainst: ["Redis pub/sub (no persistence guarantee)"],
});

const blockerCommit = makeCommit({
  hash: "block01",
  intent: "resolve-blocker",
  scope: ["search/vector"],
  decidedAgainst: ["predis PHP client (wrong ecosystem)"],
});

const deepScopeCommit = makeCommit({
  hash: "deep001",
  intent: "improve-quality",
  scope: ["auth/registration/flow"],
});

const noIntentCommit = makeCommit({
  hash: "noint01",
  scope: ["misc"],
});

const allCommits: readonly StructuredCommit[] = [
  authCommit,
  oauthCommit,
  fixCommit,
  blockerCommit,
  deepScopeCommit,
  noIntentCommit,
];

const defaultParams: QueryParams = {
  intents: [],
  scope: null,
  session: null,
  decisionsOnly: false,
  decidedAgainst: null,
  limit: 50,
};

// ---------------------------------------------------------------------------
// filterByIntents
// ---------------------------------------------------------------------------

Deno.test("filterByIntents: empty intents returns all commits", () => {
  const result = filterByIntents([])(allCommits);
  assertEquals(result.length, allCommits.length);
});

Deno.test("filterByIntents: single intent filters correctly", () => {
  const result = filterByIntents(["fix-defect"])(allCommits);
  assertEquals(result.length, 1);
  assertEquals(result[0].hash, "fix0001");
});

Deno.test("filterByIntents: multiple intents use OR semantics", () => {
  const result = filterByIntents(["fix-defect", "resolve-blocker"])(allCommits);
  assertEquals(result.length, 2);
  const hashes = result.map((c) => c.hash);
  assertEquals(hashes.includes("fix0001"), true);
  assertEquals(hashes.includes("block01"), true);
});

Deno.test("filterByIntents: excludes commits with null intent", () => {
  const result = filterByIntents(["enable-capability"])(allCommits);
  assertEquals(result.every((c) => c.intent !== null), true);
  assertEquals(result.every((c) => c.intent === "enable-capability"), true);
});

// ---------------------------------------------------------------------------
// filterByScope
// ---------------------------------------------------------------------------

Deno.test("filterByScope: hierarchical prefix match", () => {
  const result = filterByScope("auth")(allCommits);
  const hashes = result.map((c) => c.hash);
  assertEquals(hashes.includes("auth001"), true);
  assertEquals(hashes.includes("fix0001"), true);
  assertEquals(hashes.includes("deep001"), true);
});

Deno.test("filterByScope: rejects non-prefix substring", () => {
  const result = filterByScope("auth")(allCommits);
  const hashes = result.map((c) => c.hash);
  assertEquals(hashes.includes("oauth01"), false);
});

Deno.test("filterByScope: exact scope match", () => {
  const result = filterByScope("auth/registration")(allCommits);
  const hashes = result.map((c) => c.hash);
  assertEquals(hashes.includes("auth001"), true);
  assertEquals(hashes.includes("deep001"), true);
  assertEquals(hashes.includes("fix0001"), false);
});

// ---------------------------------------------------------------------------
// filterBySession
// ---------------------------------------------------------------------------

Deno.test("filterBySession: exact session match", () => {
  const result = filterBySession("2025-02-08/passkey")(allCommits);
  assertEquals(result.length, 1);
  assertEquals(result[0].hash, "auth001");
});

Deno.test("filterBySession: no match returns empty", () => {
  const result = filterBySession("nonexistent")(allCommits);
  assertEquals(result.length, 0);
});

// ---------------------------------------------------------------------------
// filterDecisionsOnly
// ---------------------------------------------------------------------------

Deno.test("filterDecisionsOnly: returns only commits with decided-against", () => {
  const result = filterDecisionsOnly(allCommits);
  assertEquals(result.length, 2);
  const hashes = result.map((c) => c.hash);
  assertEquals(hashes.includes("fix0001"), true);
  assertEquals(hashes.includes("block01"), true);
});

// ---------------------------------------------------------------------------
// filterByDecidedAgainst
// ---------------------------------------------------------------------------

Deno.test("filterByDecidedAgainst: word boundary match - finds Redis", () => {
  const result = filterByDecidedAgainst("redis")(allCommits);
  assertEquals(result.length, 1);
  assertEquals(result[0].hash, "fix0001");
});

Deno.test("filterByDecidedAgainst: word boundary - rejects predis", () => {
  const result = filterByDecidedAgainst("redis")(allCommits);
  const hashes = result.map((c) => c.hash);
  assertEquals(hashes.includes("block01"), false);
});

// ---------------------------------------------------------------------------
// applyQueryFilters - composition
// ---------------------------------------------------------------------------

Deno.test("applyQueryFilters: combines intent and scope (AND)", () => {
  const result = applyQueryFilters(allCommits, {
    ...defaultParams,
    intents: ["enable-capability"],
    scope: "auth",
  });
  assertEquals(result.length, 1);
  assertEquals(result[0].hash, "auth001");
});

Deno.test("applyQueryFilters: multi-intent OR with scope AND", () => {
  const result = applyQueryFilters(allCommits, {
    ...defaultParams,
    intents: ["fix-defect", "improve-quality"],
    scope: "auth",
  });
  assertEquals(result.length, 2);
  const hashes = result.map((c) => c.hash);
  assertEquals(hashes.includes("fix0001"), true);
  assertEquals(hashes.includes("deep001"), true);
});

Deno.test("applyQueryFilters: respects limit", () => {
  const result = applyQueryFilters(allCommits, {
    ...defaultParams,
    limit: 2,
  });
  assertEquals(result.length, 2);
});

Deno.test("applyQueryFilters: no filters returns all up to limit", () => {
  const result = applyQueryFilters(allCommits, defaultParams);
  assertEquals(result.length, allCommits.length);
});

// ---------------------------------------------------------------------------
// canUseIndex
// ---------------------------------------------------------------------------

Deno.test("canUseIndex: true when intent filter present", () => {
  assertEquals(
    canUseIndex(
      { ...defaultParams, intents: ["fix-defect"] },
      { noIndex: false, path: null },
    ),
    true,
  );
});

Deno.test("canUseIndex: false when noIndex is true", () => {
  assertEquals(
    canUseIndex(
      { ...defaultParams, intents: ["fix-defect"] },
      { noIndex: true, path: null },
    ),
    false,
  );
});

Deno.test("canUseIndex: false when path is set", () => {
  assertEquals(
    canUseIndex(
      { ...defaultParams, intents: ["fix-defect"] },
      { noIndex: false, path: "src/" },
    ),
    false,
  );
});

Deno.test("canUseIndex: false when no trailer filters", () => {
  assertEquals(
    canUseIndex(defaultParams, { noIndex: false, path: null }),
    false,
  );
});

// ---------------------------------------------------------------------------
// queryIndexForHashes
// ---------------------------------------------------------------------------

const makeIndex = (): TrailerIndex => ({
  version: 1,
  generated: "2025-02-08T10:00:00Z",
  headCommit: "abc123",
  commitCount: 5,
  byIntent: {
    "enable-capability": ["auth001", "oauth01"],
    "fix-defect": ["fix0001"],
    "resolve-blocker": ["block01"],
    "improve-quality": ["deep001"],
  },
  byScope: {
    "auth/registration": ["auth001"],
    "auth/registration/flow": ["deep001"],
    "auth/login": ["fix0001"],
    "oauth/provider": ["oauth01"],
    "search/vector": ["block01"],
  },
  bySession: {
    "2025-02-08/passkey": ["auth001"],
    "2025-02-08/oauth": ["oauth01"],
  },
  withDecidedAgainst: ["fix0001", "block01"],
  commits: {},
});

Deno.test("queryIndexForHashes: single intent", () => {
  const result = queryIndexForHashes(makeIndex(), {
    ...defaultParams,
    intents: ["fix-defect"],
  });
  assertEquals(result.length, 1);
  assertEquals(result[0], "fix0001");
});

Deno.test("queryIndexForHashes: multiple intents union", () => {
  const result = queryIndexForHashes(makeIndex(), {
    ...defaultParams,
    intents: ["fix-defect", "resolve-blocker"],
  });
  assertEquals(result.length, 2);
  assertEquals(result.includes("fix0001"), true);
  assertEquals(result.includes("block01"), true);
});

Deno.test("queryIndexForHashes: scope uses hierarchical prefix", () => {
  const result = queryIndexForHashes(makeIndex(), {
    ...defaultParams,
    scope: "auth",
  });
  // Should match auth/registration, auth/registration/flow, auth/login
  // but NOT oauth/provider
  assertEquals(result.length, 3);
  assertEquals(result.includes("auth001"), true);
  assertEquals(result.includes("fix0001"), true);
  assertEquals(result.includes("deep001"), true);
  assertEquals(result.includes("oauth01"), false);
});

Deno.test("queryIndexForHashes: intent AND scope intersection", () => {
  const result = queryIndexForHashes(makeIndex(), {
    ...defaultParams,
    intents: ["enable-capability"],
    scope: "auth",
  });
  // enable-capability: auth001, oauth01
  // scope auth prefix: auth001, fix0001, deep001
  // intersection: auth001
  assertEquals(result.length, 1);
  assertEquals(result[0], "auth001");
});

Deno.test("queryIndexForHashes: decisionsOnly filters to withDecidedAgainst", () => {
  const result = queryIndexForHashes(makeIndex(), {
    ...defaultParams,
    decisionsOnly: true,
  });
  assertEquals(result.length, 2);
  assertEquals(result.includes("fix0001"), true);
  assertEquals(result.includes("block01"), true);
});

Deno.test("queryIndexForHashes: respects limit", () => {
  const result = queryIndexForHashes(makeIndex(), {
    ...defaultParams,
    intents: ["fix-defect", "resolve-blocker"],
    limit: 1,
  });
  assertEquals(result.length, 1);
});

Deno.test("queryIndexForHashes: no filters returns empty", () => {
  const result = queryIndexForHashes(makeIndex(), defaultParams);
  assertEquals(result.length, 0);
});
