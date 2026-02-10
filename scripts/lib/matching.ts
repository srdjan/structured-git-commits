/**
 * Pure matching primitives for structured commit queries.
 *
 * These functions define the precision semantics for scope and
 * decided-against matching. They are the foundation for both
 * the composable query library and the CLI filter pipeline.
 */

/**
 * Hierarchical prefix match for scope values.
 *
 * "auth" matches "auth" and "auth/registration" but NOT "oauth/provider"
 * or "unauthorized". The pattern must match either exactly or as a
 * path prefix (followed by "/").
 */
export const scopeMatches = (scopeValue: string, pattern: string): boolean => {
  const s = scopeValue.toLowerCase();
  const p = pattern.toLowerCase();
  return s === p || (s.startsWith(p) && s[p.length] === "/");
};

/**
 * Word-boundary match for keyword searches.
 *
 * "redis" matches "Redis pub/sub" and "use Redis for caching" but NOT
 * "predis" or "redistribution". Uses regex word boundaries for precision.
 */
export const wordBoundaryMatch = (text: string, keyword: string): boolean => {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
};
