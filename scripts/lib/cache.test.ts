import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { loadCache, saveCache } from "./cache.ts";

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

Deno.test("cache: round-trip save and load preserves data", () => {
  const tmpPath = Deno.makeTempFileSync({ suffix: ".json" });

  const data: Record<string, string> = {
    "abc123": "feat(auth): add login\n\nIntent: enable-capability\nScope: auth/login",
    "def456": "fix(api): correct status code\n\nIntent: fix-defect\nScope: api/responses",
  };

  const saveResult = saveCache(data, tmpPath);
  assert(saveResult.ok);

  const loadResult = loadCache(tmpPath);
  assert(loadResult.ok);
  if (loadResult.ok) {
    assertEquals(loadResult.value, data);
  }

  Deno.removeSync(tmpPath);
});

// ---------------------------------------------------------------------------
// Missing file
// ---------------------------------------------------------------------------

Deno.test("cache: missing file returns empty cache", () => {
  const result = loadCache("/tmp/nonexistent-cache-file-" + Date.now() + ".json");

  assert(result.ok);
  if (result.ok) {
    assertEquals(result.value, {});
  }
});

// ---------------------------------------------------------------------------
// Corrupt JSON
// ---------------------------------------------------------------------------

Deno.test("cache: corrupt JSON returns error", () => {
  const tmpPath = Deno.makeTempFileSync({ suffix: ".json" });
  Deno.writeTextFileSync(tmpPath, "not valid json {{{");

  const result = loadCache(tmpPath);
  assert(!result.ok);

  Deno.removeSync(tmpPath);
});

Deno.test("cache: non-object JSON returns error", () => {
  const tmpPath = Deno.makeTempFileSync({ suffix: ".json" });
  Deno.writeTextFileSync(tmpPath, "[1, 2, 3]");

  const result = loadCache(tmpPath);
  assert(!result.ok);
  if (!result.ok) {
    assert(result.error.message.includes("not a JSON object"));
  }

  Deno.removeSync(tmpPath);
});

// ---------------------------------------------------------------------------
// Empty cache
// ---------------------------------------------------------------------------

Deno.test("cache: save and load empty cache", () => {
  const tmpPath = Deno.makeTempFileSync({ suffix: ".json" });

  const saveResult = saveCache({}, tmpPath);
  assert(saveResult.ok);

  const loadResult = loadCache(tmpPath);
  assert(loadResult.ok);
  if (loadResult.ok) {
    assertEquals(loadResult.value, {});
  }

  Deno.removeSync(tmpPath);
});
