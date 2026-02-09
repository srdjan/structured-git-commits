/**
 * Simple JSON file cache for retrofit resume support.
 *
 * Maps commit hashes to generated structured messages. Enables
 * resuming after interruption without re-calling the API.
 */

import { Result } from "../types.ts";

export const loadCache = (
  path: string,
): Result<Record<string, string>> => {
  try {
    const text = Deno.readTextFileSync(path);
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return Result.fail(new Error("Cache file is not a JSON object"));
    }
    return Result.ok(parsed as Record<string, string>);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return Result.ok({});
    }
    return Result.fail(
      e instanceof Error ? e : new Error(String(e)),
    );
  }
};

export const saveCache = (
  cache: Record<string, string>,
  path: string,
): Result<void> => {
  try {
    Deno.writeTextFileSync(path, JSON.stringify(cache, null, 2) + "\n");
    return Result.ok(undefined);
  } catch (e) {
    return Result.fail(
      e instanceof Error ? e : new Error(String(e)),
    );
  }
};
