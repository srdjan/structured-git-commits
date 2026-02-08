/**
 * Structured Git Commit Parser - CLI
 *
 * Parses git log output into structured commit objects with typed trailers.
 * Designed for agent memory reconstruction from commit history.
 *
 * Usage:
 *   deno run --allow-run scripts/parse-commits.ts [options]
 *
 * Options:
 *   --limit=N                  Number of commits to parse (default: 50)
 *   --intent=TYPE              Filter by intent type
 *   --scope=PATTERN            Filter by scope (substring match)
 *   --session=ID               Filter by session identifier
 *   --decisions-only           Show only commits with Decided-Against trailers
 *   --decided-against=KEYWORD  Filter commits where Decided-Against contains keyword
 *   --with-body                Include commit body in text output
 *   --format=json|text         Output format (default: text)
 *   --since=DATE               Git --since filter
 *   --path=PATH                Git -- path filter
 */

import type { IntentType, StructuredCommit } from "./types.ts";
import { Result } from "./types.ts";
import { isIntentType, parseCommitBlock } from "./lib/parser.ts";

// ---------------------------------------------------------------------------
// Git Integration
// ---------------------------------------------------------------------------

interface CliOptions {
  readonly limit: number;
  readonly intent: IntentType | null;
  readonly scope: string | null;
  readonly session: string | null;
  readonly decisionsOnly: boolean;
  readonly decidedAgainst: string | null;
  readonly withBody: boolean;
  readonly format: "json" | "text";
  readonly since: string | null;
  readonly path: string | null;
}

const buildGitArgs = (options: CliOptions): string[] => {
  const args = [
    "log",
    `-${options.limit}`,
    "--format=---commit---%nHash: %H%nDate: %aI%nSubject: %s%n%b",
  ];

  if (options.since) args.push(`--since=${options.since}`);
  if (options.intent) args.push(`--grep=Intent: ${options.intent}`);
  if (options.session) args.push(`--grep=Session: ${options.session}`);
  if (options.path) {
    args.push("--");
    args.push(options.path);
  }

  return args;
};

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
// Filtering
// ---------------------------------------------------------------------------

const applyFilters = (
  commits: readonly StructuredCommit[],
  options: CliOptions,
): readonly StructuredCommit[] => {
  let filtered = [...commits];

  if (options.scope) {
    const pattern = options.scope.toLowerCase();
    filtered = filtered.filter((c) =>
      c.scope.some((s) => s.toLowerCase().includes(pattern))
    );
  }

  if (options.decisionsOnly) {
    filtered = filtered.filter((c) => c.decidedAgainst.length > 0);
  }

  if (options.decidedAgainst) {
    const keyword = options.decidedAgainst.toLowerCase();
    filtered = filtered.filter((c) =>
      c.decidedAgainst.some((d) => d.toLowerCase().includes(keyword))
    );
  }

  return filtered;
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
// CLI
// ---------------------------------------------------------------------------

const parseCliArgs = (args: string[]): CliOptions => {
  const get = (key: string): string | null => {
    const arg = args.find((a) => a.startsWith(`--${key}=`));
    return arg ? arg.split("=").slice(1).join("=") : null;
  };

  const has = (key: string): boolean => args.includes(`--${key}`);

  const intentRaw = get("intent");
  const intent = intentRaw && isIntentType(intentRaw) ? intentRaw : null;

  const formatRaw = get("format");
  const format = formatRaw === "json" ? "json" : "text";

  const limitRaw = get("limit");
  const limit = limitRaw !== null ? parseInt(limitRaw, 10) : 50;
  if (Number.isNaN(limit) || limit <= 0) {
    console.error(`Invalid --limit value: "${limitRaw}". Must be a positive integer.`);
    Deno.exit(2);
  }

  return {
    limit,
    intent,
    scope: get("scope"),
    session: get("session"),
    decisionsOnly: has("decisions-only"),
    decidedAgainst: get("decided-against"),
    withBody: has("with-body"),
    format,
    since: get("since"),
    path: get("path"),
  };
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  const options = parseCliArgs(Deno.args);

  const gitArgs = buildGitArgs(options);
  const logResult = await execGitLog(gitArgs);

  if (!logResult.ok) {
    console.error(`Error: ${logResult.error.message}`);
    Deno.exit(1);
  }

  const blocks = logResult.value
    .split("---commit---")
    .filter((b) => b.trim().length > 0);

  const results = blocks.map(parseCommitBlock);

  const commits = results
    .filter((r): r is { ok: true; value: StructuredCommit } => r.ok)
    .map((r) => r.value);

  const errors = results
    .filter((r): r is { ok: false; error: import("./types.ts").ParseError } => !r.ok)
    .map((r) => r.error);

  const filtered = applyFilters(commits, options);

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
