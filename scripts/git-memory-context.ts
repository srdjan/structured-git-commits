/**
 * Git Memory Context - UserPromptSubmit Hook
 *
 * Produces a compact summary of recent git history context, injected
 * automatically before every Claude prompt via the UserPromptSubmit hook.
 *
 * Provides a passive floor of always-available context: recent commits,
 * recent decided-against entries, and current session info. Does not
 * analyze the user's prompt - always produces the same deterministic dump.
 *
 * Design:
 *   - Primary path: loads trailer index via loadIndex() (pure file I/O)
 *   - Fallback path: runs git log + parseCommitBlock for recent commits
 *   - Target: completes in under 500ms
 *   - Exits 0 with empty string on any error (never blocks the user)
 *
 * Usage:
 *   deno run --allow-run --allow-read --allow-env scripts/git-memory-context.ts
 */

import type { IndexedCommit, TrailerIndex } from "./types.ts";
import { Result } from "./types.ts";
import { loadIndex } from "./build-trailer-index.ts";
import { parseCommitBlock } from "./lib/parser.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RECENT_COMMITS = 10;
const MAX_DECISIONS = 20;

// ---------------------------------------------------------------------------
// Git Fallback
// ---------------------------------------------------------------------------

const execGitLog = async (
  args: readonly string[],
): Promise<Result<string>> => {
  try {
    const command = new Deno.Command("git", {
      args: ["log", ...args] as string[],
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
// Index Path: extract from TrailerIndex directly
// ---------------------------------------------------------------------------

interface DecisionEntry {
  readonly scope: readonly string[];
  readonly text: string;
}

interface ContextData {
  readonly recentCommits: readonly {
    readonly hash: string;
    readonly subject: string;
    readonly scope: readonly string[];
  }[];
  readonly decisions: readonly DecisionEntry[];
  readonly session: { readonly id: string; readonly commitCount: number } | null;
}

const extractFromIndex = (index: TrailerIndex): ContextData => {
  // Recent commits: sort by date descending, take first N
  const allCommits = Object.values(index.commits) as IndexedCommit[];
  const sorted = allCommits
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, MAX_RECENT_COMMITS);

  const recentCommits = sorted.map((c) => ({
    hash: c.hash,
    subject: c.subject,
    scope: c.scope,
  }));

  // Decisions: iterate withDecidedAgainst hashes, collect entries
  const decisions: DecisionEntry[] = [];
  for (const hash of index.withDecidedAgainst) {
    if (decisions.length >= MAX_DECISIONS) break;
    const commit = index.commits[hash];
    if (!commit) continue;
    for (const text of commit.decidedAgainst) {
      if (decisions.length >= MAX_DECISIONS) break;
      decisions.push({ scope: commit.scope, text });
    }
  }

  // Session: check env var
  const sessionId = Deno.env.get("STRUCTURED_GIT_SESSION") ?? null;
  let session: ContextData["session"] = null;
  if (sessionId && index.bySession[sessionId]) {
    session = {
      id: sessionId,
      commitCount: index.bySession[sessionId].length,
    };
  }

  return { recentCommits, decisions, session };
};

// ---------------------------------------------------------------------------
// Fallback Path: git log + parseCommitBlock
// ---------------------------------------------------------------------------

const extractFromGitLog = async (): Promise<Result<ContextData>> => {
  const logResult = await execGitLog([
    `-${MAX_RECENT_COMMITS}`,
    "--format=---commit---%nHash: %H%nDate: %aI%nSubject: %s%n%b",
  ]);

  if (!logResult.ok) return logResult as Result<never>;

  const blocks = logResult.value
    .split("---commit---")
    .filter((b) => b.trim().length > 0);

  const parsed = blocks
    .map(parseCommitBlock)
    .filter((r): r is { ok: true; value: import("./types.ts").StructuredCommit } => r.ok)
    .map((r) => r.value);

  const recentCommits = parsed.map((c) => ({
    hash: c.hash,
    subject: `${c.type}(${c.headerScope ?? "*"}): ${c.subject}`,
    scope: c.scope,
  }));

  const decisions: DecisionEntry[] = [];
  for (const c of parsed) {
    if (decisions.length >= MAX_DECISIONS) break;
    for (const text of c.decidedAgainst) {
      if (decisions.length >= MAX_DECISIONS) break;
      decisions.push({ scope: c.scope, text });
    }
  }

  const sessionId = Deno.env.get("STRUCTURED_GIT_SESSION") ?? null;
  let session: ContextData["session"] = null;
  if (sessionId) {
    const count = parsed.filter((c) => c.session === sessionId).length;
    if (count > 0) session = { id: sessionId, commitCount: count };
  }

  return Result.ok({ recentCommits, decisions, session });
};

// ---------------------------------------------------------------------------
// Output Formatting
// ---------------------------------------------------------------------------

const formatContext = (data: ContextData): string => {
  if (data.recentCommits.length === 0) return "";

  const lines: string[] = [];

  // Decisions section
  if (data.decisions.length > 0) {
    lines.push("Recent decisions (decided-against):");
    for (const d of data.decisions) {
      const scopeLabel = d.scope.length > 0
        ? `[${d.scope.join(", ")}] `
        : "";
      lines.push(`- ${scopeLabel}${d.text}`);
    }
    lines.push("");
  }

  // Recent commits section
  lines.push("Recent commits:");
  for (const c of data.recentCommits) {
    const scopeSuffix = c.scope.length > 0
      ? ` | ${c.scope.join(", ")}`
      : "";
    lines.push(`${c.hash.slice(0, 7)} ${c.subject}${scopeSuffix}`);
  }

  // Session section
  if (data.session) {
    lines.push("");
    lines.push(
      `Session: ${data.session.id} (${data.session.commitCount} commit${data.session.commitCount === 1 ? "" : "s"})`,
    );
  }

  return `<git-memory-context>\n${lines.join("\n")}\n</git-memory-context>`;
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  // Drain stdin (hook sends JSON on stdin, but we don't use it)
  try {
    if (!Deno.stdin.isTerminal()) {
      await Deno.stdin.readable.cancel();
    }
  } catch {
    // Ignore stdin errors
  }

  // Try index path first (pure file I/O, no git subprocess)
  const indexResult = await loadIndex();
  if (indexResult.ok && indexResult.value !== null) {
    const data = extractFromIndex(indexResult.value);
    const output = formatContext(data);
    if (output) console.log(output);
    return;
  }

  // Fallback: git log + parse
  const fallbackResult = await extractFromGitLog();
  if (fallbackResult.ok) {
    const output = formatContext(fallbackResult.value);
    if (output) console.log(output);
    return;
  }

  // Any error: exit silently with 0
};

if (import.meta.main) {
  main();
}
