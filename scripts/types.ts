/**
 * Shared types for structured git commit parsing and validation.
 *
 * Single source of truth for intent taxonomy, conventional commit types,
 * and domain models used by both parser and validator.
 */

// ---------------------------------------------------------------------------
// Controlled Vocabulary
// ---------------------------------------------------------------------------

export const INTENT_TYPES = [
  "enable-capability",
  "fix-defect",
  "improve-quality",
  "restructure",
  "configure-infra",
  "document",
  "explore",
  "resolve-blocker",
] as const;

export type IntentType = (typeof INTENT_TYPES)[number];

export const CONVENTIONAL_TYPES = [
  "feat",
  "fix",
  "refactor",
  "perf",
  "docs",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
] as const;

export type ConventionalType = (typeof CONVENTIONAL_TYPES)[number];

/**
 * Trailer keys recognized by the structured git commits format.
 * Keys outside this set are ignored during trailer extraction to prevent
 * false positives from body text containing colons (e.g., URLs, env vars).
 *
 * Includes both structured-commit trailers and standard git trailers.
 */
export const KNOWN_TRAILER_KEYS = new Set([
  // Structured commit trailers
  "intent",
  "scope",
  "decided-against",
  "session",
  "refs",
  "context",
  "breaking",
  // Standard git trailers
  "signed-off-by",
  "co-authored-by",
  "reviewed-by",
  "acked-by",
  "tested-by",
  "reported-by",
  "helped-by",
  "cc",
]);

// ---------------------------------------------------------------------------
// Domain Models
// ---------------------------------------------------------------------------

export interface StructuredCommit {
  readonly hash: string;
  readonly date: string;
  readonly type: ConventionalType;
  readonly headerScope: string | null;
  readonly subject: string;
  readonly body: string;
  readonly intent: IntentType | null;
  readonly scope: readonly string[];
  readonly decidedAgainst: readonly string[];
  readonly session: string | null;
  readonly refs: readonly string[];
  readonly context: Record<string, unknown> | null;
  readonly breaking: string | null;
  readonly raw: string;
}

export interface ParseError {
  readonly hash: string;
  readonly reason: string;
  readonly raw: string;
}

// ---------------------------------------------------------------------------
// Retrofit Types
// ---------------------------------------------------------------------------

export interface CommitExtract {
  readonly hash: string;
  readonly date: string;
  readonly author: string;
  readonly message: string;
  readonly stat: string;
  readonly shortstat: string;
}

export interface RetrofitResult {
  readonly extract: CommitExtract;
  readonly generated: string | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly retried: boolean;
  readonly cached: boolean;
  readonly error: string | null;
}

// ---------------------------------------------------------------------------
// Result Type
// ---------------------------------------------------------------------------

export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const Result = {
  ok: <T>(value: T): Result<T, never> => ({ ok: true, value }),
  fail: <E>(error: E): Result<never, E> => ({ ok: false, error }),
};

// ---------------------------------------------------------------------------
// Validation Types
// ---------------------------------------------------------------------------

export type Severity = "error" | "warning";

export interface Diagnostic {
  readonly severity: Severity;
  readonly rule: string;
  readonly message: string;
}
