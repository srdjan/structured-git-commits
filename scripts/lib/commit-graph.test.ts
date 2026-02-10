import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { writeCommitGraph, verifyCommitGraph } from "../maintain-commit-graph.ts";

// These tests spawn git subprocesses, so we disable resource/op sanitizers
const testOpts = { sanitizeResources: false, sanitizeOps: false };

// ---------------------------------------------------------------------------
// writeCommitGraph
// ---------------------------------------------------------------------------

Deno.test({
  name: "writeCommitGraph: creates commit-graph file",
  ...testOpts,
  fn: async () => {
    const result = await writeCommitGraph();
    assert(result.ok, `Expected ok but got error: ${!result.ok ? result.error.message : ""}`);

    const { stats } = result.value;
    assert(stats.exists, "Commit-graph file should exist after write");
    assert(stats.fileSize > 0, "Commit-graph file should have non-zero size");
    assert(
      stats.commitCount !== null && stats.commitCount > 0,
      "Should report at least one reachable commit",
    );
  },
});

Deno.test({
  name: "writeCommitGraph: enables changed-paths Bloom filters",
  ...testOpts,
  fn: async () => {
    const result = await writeCommitGraph();
    assert(result.ok);

    assert(
      result.value.stats.changedPaths,
      "Changed-paths Bloom filters should be active",
    );
  },
});

// ---------------------------------------------------------------------------
// verifyCommitGraph
// ---------------------------------------------------------------------------

Deno.test({
  name: "verifyCommitGraph: validates existing commit-graph",
  ...testOpts,
  fn: async () => {
    // Ensure a graph exists first
    const writeResult = await writeCommitGraph();
    assert(writeResult.ok);

    const verifyResult = await verifyCommitGraph();
    assert(verifyResult.ok);
    assert(verifyResult.value.valid, "Freshly written graph should be valid");
    assertEquals(verifyResult.value.message, "Commit-graph integrity verified");
  },
});
