/**
 * Composable query operations over structured commits.
 *
 * Each filter is a pure function: commits in, commits out.
 * These are designed as RLM "environment operations" that agents
 * can compose programmatically, independent of the CLI.
 *
 * Usage:
 *   import { filterByIntents, filterByScope, applyQueryFilters } from "./query.ts";
 *
 *   // Compose filters manually
 *   const result = filterByScope("auth")(filterByIntents(["fix-defect"])(commits));
 *
 *   // Or use the all-in-one composition
 *   const result = applyQueryFilters(commits, { intents: ["fix-defect"], scope: "auth", ... });
 */

import type { IntentType, StructuredCommit, TrailerIndex } from "../types.ts";
import { scopeMatches, wordBoundaryMatch } from "./matching.ts";

// ---------------------------------------------------------------------------
// Query Parameters
// ---------------------------------------------------------------------------

export interface QueryParams {
  readonly intents: readonly IntentType[];
  readonly scope: string | null;
  readonly session: string | null;
  readonly decisionsOnly: boolean;
  readonly decidedAgainst: string | null;
  readonly limit: number;
}

// ---------------------------------------------------------------------------
// Composable Filter Functions
// ---------------------------------------------------------------------------

/** Filter commits by intent types (OR across intents, AND with other filters). */
export const filterByIntents =
  (intents: readonly IntentType[]) =>
  (commits: readonly StructuredCommit[]): readonly StructuredCommit[] => {
    if (intents.length === 0) return commits;
    return commits.filter((c) => c.intent !== null && intents.includes(c.intent));
  };

/** Filter commits by scope using hierarchical prefix matching. */
export const filterByScope =
  (pattern: string) =>
  (commits: readonly StructuredCommit[]): readonly StructuredCommit[] =>
    commits.filter((c) => c.scope.some((s) => scopeMatches(s, pattern)));

/** Filter commits by exact session match. */
export const filterBySession =
  (session: string) =>
  (commits: readonly StructuredCommit[]): readonly StructuredCommit[] =>
    commits.filter((c) => c.session === session);

/** Filter to only commits that have decided-against entries. */
export const filterDecisionsOnly = (
  commits: readonly StructuredCommit[],
): readonly StructuredCommit[] =>
  commits.filter((c) => c.decidedAgainst.length > 0);

/** Filter commits by decided-against keyword using word-boundary matching. */
export const filterByDecidedAgainst =
  (keyword: string) =>
  (commits: readonly StructuredCommit[]): readonly StructuredCommit[] =>
    commits.filter((c) =>
      c.decidedAgainst.some((d) => wordBoundaryMatch(d, keyword))
    );

// ---------------------------------------------------------------------------
// Composed Filter
// ---------------------------------------------------------------------------

/**
 * Apply all query filters based on a QueryParams object.
 * Composes individual filters in sequence: intents, scope, session,
 * decisionsOnly, decidedAgainst, then limit.
 */
export const applyQueryFilters = (
  commits: readonly StructuredCommit[],
  params: QueryParams,
): readonly StructuredCommit[] => {
  let result: readonly StructuredCommit[] = commits;

  if (params.intents.length > 0) {
    result = filterByIntents(params.intents)(result);
  }

  if (params.scope) {
    result = filterByScope(params.scope)(result);
  }

  if (params.session) {
    result = filterBySession(params.session)(result);
  }

  if (params.decisionsOnly) {
    result = filterDecisionsOnly(result);
  }

  if (params.decidedAgainst) {
    result = filterByDecidedAgainst(params.decidedAgainst)(result);
  }

  return result.slice(0, params.limit);
};

// ---------------------------------------------------------------------------
// Index-based Query
// ---------------------------------------------------------------------------

/**
 * Determine whether the trailer index can satisfy this query.
 * The index handles intent, scope, session, and decided-against filters.
 * Path-based and since-date queries must go through git log.
 */
export const canUseIndex = (
  params: QueryParams,
  opts: { readonly noIndex: boolean; readonly path: string | null },
): boolean => {
  if (opts.noIndex) return false;
  if (opts.path) return false;
  const hasTrailerFilter = !!(
    params.intents.length > 0 ||
    params.scope ||
    params.session ||
    params.decisionsOnly ||
    params.decidedAgainst
  );
  return hasTrailerFilter;
};

/**
 * Resolve matching commit hashes from the trailer index.
 * Takes explicit QueryParams instead of CLI options.
 *
 * For multiple intents, unions hashes across intent keys (OR semantics).
 * All other filters intersect (AND semantics).
 */
export const queryIndexForHashes = (
  index: TrailerIndex,
  params: QueryParams,
): readonly string[] => {
  let candidateHashes: Set<string> | null = null;

  const intersect = (hashes: readonly string[]): void => {
    const set = new Set(hashes);
    if (candidateHashes === null) {
      candidateHashes = set;
    } else {
      for (const h of candidateHashes) {
        if (!set.has(h)) candidateHashes.delete(h);
      }
    }
  };

  // Multiple intents: union across intent keys, then intersect with other filters
  if (params.intents.length > 0) {
    const intentHashes = new Set<string>();
    for (const intent of params.intents) {
      for (const h of index.byIntent[intent] ?? []) {
        intentHashes.add(h);
      }
    }
    intersect([...intentHashes]);
  }

  if (params.session) {
    intersect(index.bySession[params.session] ?? []);
  }

  if (params.decisionsOnly || params.decidedAgainst) {
    intersect(index.withDecidedAgainst);
  }

  if (params.scope) {
    // Hierarchical prefix match across scope keys
    const matchingHashes: string[] = [];
    for (const [scopeKey, hashes] of Object.entries(index.byScope)) {
      if (scopeMatches(scopeKey, params.scope)) {
        matchingHashes.push(...hashes);
      }
    }
    intersect(matchingHashes);
  }

  if (candidateHashes === null) return [];
  return [...candidateHashes].slice(0, params.limit);
};
