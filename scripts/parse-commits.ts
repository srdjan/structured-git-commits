/**
 * RLM Git Commit Parser - CLI
 *
 * Thin CLI wrapper over the composable query library.
 * Parses git log output into structured commit objects with typed trailers.
 * Designed for agent memory reconstruction from commit history.
 *
 * Usage:
 *   deno run --allow-run scripts/parse-commits.ts [options]
 *
 * Options:
 *   --limit=N                  Number of commits to parse (default: 50)
 *   --intent=TYPE              Filter by intent type (repeatable for OR)
 *   --scope=PATTERN            Filter by scope (hierarchical prefix match)
 *   --session=ID               Filter by session identifier
 *   --decisions-only           Show only commits with Decided-Against trailers
 *   --decided-against=KEYWORD  Filter commits where Decided-Against contains keyword (word boundary)
 *   --with-body                Include commit body in text output
 *   --format=json|text         Output format (default: text)
 *   --since=DATE               Git --since filter
 *   --since-commit=HASH        Ancestry-based boundary (uses commit-graph generation numbers)
 *   --path=PATH                Git -- path filter
 *   --no-index                 Skip trailer index even if available
 */

import type { IntentType, StructuredCommit } from "./types.ts";
import { Result } from "./types.ts";
import { isIntentType, parseCommitBlock } from "./lib/parser.ts";
import { loadIndex } from "./build-trailer-index.ts";
import {
  applyQueryFilters,
  canUseIndex,
  queryIndexForHashes,
  type QueryParams,
} from "./lib/query.ts";

// ---------------------------------------------------------------------------
// CLI Types
// ---------------------------------------------------------------------------

interface CliOptions {
  readonly limit: number;
  readonly intents: readonly IntentType[];
  readonly scope: string | null;
  readonly session: string | null;
  readonly decisionsOnly: boolean;
  readonly decidedAgainst: string | null;
  readonly withBody: boolean;
  readonly format: "json" | "text";
  readonly since: string | null;
  readonly sinceCommit: string | null;
  readonly path: string | null;
  readonly noIndex: boolean;
}

// ---------------------------------------------------------------------------
// Git Integration
// ---------------------------------------------------------------------------

const buildGitArgs = (options: CliOptions): string[] => {
  const args = [
    "log",
    `-${options.limit}`,
    "--format=---commit---%nHash: %H%nDate: %aI%nSubject: %s%n%b",
  ];

  if (options.since) args.push(`--since=${options.since}`);

  // Single intent can use git --grep pre-filter. Multiple intents conflict
  // with git's OR semantics across --grep patterns, so we filter post-parse.
  if (options.intents.length === 1) {
    args.push(`--grep=Intent: ${options.intents[0]}`);
  }

  if (options.session) args.push(`--grep=Session: ${options.session}`);
  if (options.sinceCommit) args.push(`${options.sinceCommit}..HEAD`);
  if (options.path) {
    args.push("--");
    args.push(options.path);
  }

  return args;
};

const buildGitArgsForHashes = (hashes: readonly string[]): string[] => [
  "log",
  "--format=---commit---%nHash: %H%nDate: %aI%nSubject: %s%n%b",
  "--no-walk",
  ...(hashes as string[]),
];

const execGitLog = async (
  args: readonly string[],
): Promise<Result<string>> => {
  try {
    const command = new Deno.Command("git", {
      args: args as string[],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();

    if (!output.success) {
      const stderr = new TextDecoder().decode(output.stderr);
      return Result.fail(new Error(`git log failed: ${stderr}`));
    }

    return Result.ok(new TextDecoder().decode(output.stdout));
  } catch (e) {
    return Result.fail(e as Error);
  }
};

// ---------------------------------------------------------------------------
// Output Formatting
// ---------------------------------------------------------------------------

const SEPARATOR = "---";

const formatText = (
  commits: readonly StructuredCommit[],
  withBody: boolean,
): string => {
  if (commits.length === 0) return "No structured commits found.";

  const formatted = commits.map((c) => {
    const lines: string[] = [];

    // Header: type(scope): subject
    lines.push(`${c.type}(${c.headerScope ?? "*"}): ${c.subject}`);

    // Metadata line: hash, date, intent
    const intent = c.intent ?? "unknown";
    const meta = [`${c.hash.slice(0, 8)}`, c.date.slice(0, 10), intent];
    if (c.session) meta.push(c.session);
    lines.push(`  ${meta.join("  ")}`);

    // Scope
    if (c.scope.length > 0) {
      lines.push(`  scope: ${c.scope.join(", ")}`);
    }

    // Body
    if (withBody && c.body) {
      lines.push("");
      for (const bodyLine of c.body.split("\n")) {
        lines.push(`  ${bodyLine}`);
      }
    }

    // Decisions (visually distinct)
    if (c.decidedAgainst.length > 0) {
      lines.push("");
      for (const d of c.decidedAgainst) {
        lines.push(`  [-] ${d}`);
      }
    }

    // Refs
    if (c.refs.length > 0) {
      lines.push(`  refs: ${c.refs.join(", ")}`);
    }

    // Breaking
    if (c.breaking) {
      lines.push(`  BREAKING: ${c.breaking}`);
    }

    return lines.join("\n");
  });

  return formatted.join(`\n${SEPARATOR}\n`);
};

const formatJson = (commits: readonly StructuredCommit[]): string =>
  JSON.stringify(commits, null, 2);

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------

const parseCliArgs = (args: string[]): CliOptions => {
  const get = (key: string): string | null => {
    const arg = args.find((a) => a.startsWith(`--${key}=`));
    return arg ? arg.split("=").slice(1).join("=") : null;
  };

  const getAll = (key: string): string[] =>
    args
      .filter((a) => a.startsWith(`--${key}=`))
      .map((a) => a.split("=").slice(1).join("="));

  const has = (key: string): boolean => args.includes(`--${key}`);

  const intents = getAll("intent").filter(isIntentType) as IntentType[];

  const formatRaw = get("format");
  const format = formatRaw === "json" ? "json" : "text";

  const limitRaw = get("limit");
  const limit = limitRaw !== null ? parseInt(limitRaw, 10) : 50;
  if (Number.isNaN(limit) || limit <= 0) {
    console.error(
      `Invalid --limit value: "${limitRaw}". Must be a positive integer.`,
    );
    Deno.exit(2);
  }

  return {
    limit,
    intents,
    scope: get("scope"),
    session: get("session"),
    decisionsOnly: has("decisions-only"),
    decidedAgainst: get("decided-against"),
    withBody: has("with-body"),
    format,
    since: get("since"),
    sinceCommit: get("since-commit"),
    path: get("path"),
    noIndex: has("no-index"),
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert CLI options to the library's QueryParams. */
const toQueryParams = (options: CliOptions): QueryParams => ({
  intents: options.intents,
  scope: options.scope,
  session: options.session,
  decisionsOnly: options.decisionsOnly,
  decidedAgainst: options.decidedAgainst,
  limit: options.limit,
});

const parseGitOutput = (raw: string) => {
  const blocks = raw
    .split("---commit---")
    .filter((b) => b.trim().length > 0);

  const results = blocks.map(parseCommitBlock);

  const commits = results
    .filter((r): r is { ok: true; value: StructuredCommit } => r.ok)
    .map((r) => r.value);

  const errors = results
    .filter(
      (r): r is { ok: false; error: import("./types.ts").ParseError } => !r.ok,
    )
    .map((r) => r.error);

  return { commits, errors };
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  const options = parseCliArgs(Deno.args);
  const params = toQueryParams(options);

  // Try index-based query for trailer filters
  if (canUseIndex(params, { noIndex: options.noIndex, path: options.path })) {
    const indexResult = await loadIndex();

    if (indexResult.ok && indexResult.value !== null) {
      const indexHashes = queryIndexForHashes(indexResult.value, params);

      if (indexHashes.length > 0) {
        const gitArgs = buildGitArgsForHashes(indexHashes);
        const logResult = await execGitLog(gitArgs);

        if (logResult.ok) {
          const { commits, errors } = parseGitOutput(logResult.value);

          // Index pre-filtered by intent/session/scope keys, but apply
          // full precision filters (word boundary for decided-against,
          // hierarchical prefix for scope on multi-scope commits)
          const filtered = applyQueryFilters(commits, params);

          const output = options.format === "json"
            ? formatJson(filtered)
            : formatText(filtered, options.withBody);

          console.log(output);

          if (errors.length > 0 && options.format === "text") {
            console.error(
              `\n${errors.length} commit(s) could not be parsed (non-structured or malformed)`,
            );
          }
          return;
        }
        // If git log for hashes failed, fall through to standard path
      } else {
        // Index is fresh but no matches
        console.log(
          options.format === "json" ? "[]" : "No structured commits found.",
        );
        return;
      }
    }
    // Index unavailable, fall through
  }

  // Standard git log path (no index or path-based query)
  const gitArgs = buildGitArgs(options);
  const logResult = await execGitLog(gitArgs);

  if (!logResult.ok) {
    console.error(`Error: ${logResult.error.message}`);
    Deno.exit(1);
  }

  const { commits, errors } = parseGitOutput(logResult.value);

  // Apply all filters. For the git-log path, git --grep handles single-intent
  // pre-filtering, but we still need library filters for multi-intent,
  // scope precision, and decided-against word boundaries.
  const filtered = applyQueryFilters(commits, params);

  const output = options.format === "json"
    ? formatJson(filtered)
    : formatText(filtered, options.withBody);

  console.log(output);

  if (errors.length > 0 && options.format === "text") {
    console.error(
      `\n${errors.length} commit(s) could not be parsed (non-structured or malformed)`,
    );
  }
};

main();
