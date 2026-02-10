/**
 * Trailer Index Builder - CLI
 *
 * Builds an inverted index of trailer values to commit hashes, enabling
 * O(1) lookups for intent, scope, session, and decided-against queries.
 * The index is stored at `.git/info/trailer-index.json`.
 *
 * Usage:
 *   deno run --allow-run --allow-read --allow-write scripts/build-trailer-index.ts [options]
 *
 * Options:
 *   --check    Check freshness without rebuilding (exit 0 if fresh, 1 if stale)
 */

import type { IndexedCommit, IntentType, StructuredCommit, TrailerIndex } from "./types.ts";
import { Result } from "./types.ts";
import { parseCommitBlock } from "./lib/parser.ts";

// ---------------------------------------------------------------------------
// Git Commands
// ---------------------------------------------------------------------------

const execGit = async (
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
      return Result.fail(new Error(`git ${args[0]} failed: ${stderr}`));
    }

    return Result.ok(new TextDecoder().decode(output.stdout));
  } catch (e) {
    return Result.fail(e as Error);
  }
};

const getGitDir = async (): Promise<Result<string>> => {
  const result = await execGit(["rev-parse", "--git-dir"]);
  if (!result.ok) return result;
  return Result.ok(result.value.trim());
};

const getHeadCommit = async (): Promise<Result<string>> => {
  const result = await execGit(["rev-parse", "HEAD"]);
  if (!result.ok) return result;
  return Result.ok(result.value.trim());
};

// ---------------------------------------------------------------------------
// Index Path
// ---------------------------------------------------------------------------

const getIndexPath = async (): Promise<Result<string>> => {
  const gitDirResult = await getGitDir();
  if (!gitDirResult.ok) return gitDirResult;
  return Result.ok(`${gitDirResult.value}/info/trailer-index.json`);
};

// ---------------------------------------------------------------------------
// Freshness Check
// ---------------------------------------------------------------------------

export const checkFreshness = async (): Promise<
  Result<{ fresh: boolean; indexPath: string; currentHead: string }>
> => {
  const indexPathResult = await getIndexPath();
  if (!indexPathResult.ok) return indexPathResult as Result<never>;

  const headResult = await getHeadCommit();
  if (!headResult.ok) return headResult as Result<never>;

  const indexPath = indexPathResult.value;
  const currentHead = headResult.value;

  try {
    const content = await Deno.readTextFile(indexPath);
    const index: TrailerIndex = JSON.parse(content);
    return Result.ok({
      fresh: index.headCommit === currentHead,
      indexPath,
      currentHead,
    });
  } catch {
    return Result.ok({ fresh: false, indexPath, currentHead });
  }
};

// ---------------------------------------------------------------------------
// Index Loading
// ---------------------------------------------------------------------------

export const loadIndex = async (): Promise<Result<TrailerIndex | null>> => {
  const freshnessResult = await checkFreshness();
  if (!freshnessResult.ok) return freshnessResult as Result<never>;

  if (!freshnessResult.value.fresh) {
    return Result.ok(null);
  }

  try {
    const content = await Deno.readTextFile(freshnessResult.value.indexPath);
    const index: TrailerIndex = JSON.parse(content);
    if (index.version !== 1) return Result.ok(null);
    return Result.ok(index);
  } catch {
    return Result.ok(null);
  }
};

// ---------------------------------------------------------------------------
// Index Building
// ---------------------------------------------------------------------------

const toIndexedCommit = (commit: StructuredCommit): IndexedCommit => ({
  hash: commit.hash,
  date: commit.date,
  subject: `${commit.type}(${commit.headerScope ?? "*"}): ${commit.subject}`,
  intent: commit.intent,
  scope: commit.scope,
  session: commit.session,
  decidedAgainst: commit.decidedAgainst,
});

export const buildIndex = async (): Promise<Result<TrailerIndex>> => {
  const headResult = await getHeadCommit();
  if (!headResult.ok) return headResult as Result<never>;

  // Fetch all commits
  const logResult = await execGit([
    "log",
    "--format=---commit---%nHash: %H%nDate: %aI%nSubject: %s%n%b",
  ]);
  if (!logResult.ok) return logResult as Result<never>;

  const blocks = logResult.value
    .split("---commit---")
    .filter((b) => b.trim().length > 0);

  const parsed = blocks.map(parseCommitBlock);
  const commits = parsed
    .filter((r): r is { ok: true; value: StructuredCommit } => r.ok)
    .map((r) => r.value);

  // Build inverted indices
  const byIntent: Partial<Record<IntentType, string[]>> = {};
  const byScope: Record<string, string[]> = {};
  const bySession: Record<string, string[]> = {};
  const withDecidedAgainst: string[] = [];
  const indexedCommits: Record<string, IndexedCommit> = {};

  for (const commit of commits) {
    indexedCommits[commit.hash] = toIndexedCommit(commit);

    if (commit.intent) {
      if (!byIntent[commit.intent]) {
        byIntent[commit.intent] = [];
      }
      byIntent[commit.intent]!.push(commit.hash);
    }

    for (const scope of commit.scope) {
      if (!byScope[scope]) {
        byScope[scope] = [];
      }
      byScope[scope].push(commit.hash);
    }

    if (commit.session) {
      if (!bySession[commit.session]) {
        bySession[commit.session] = [];
      }
      bySession[commit.session].push(commit.hash);
    }

    if (commit.decidedAgainst.length > 0) {
      withDecidedAgainst.push(commit.hash);
    }
  }

  const index: TrailerIndex = {
    version: 1,
    generated: new Date().toISOString(),
    headCommit: headResult.value,
    commitCount: commits.length,
    byIntent,
    byScope,
    bySession,
    withDecidedAgainst,
    commits: indexedCommits,
  };

  return Result.ok(index);
};

// ---------------------------------------------------------------------------
// Index Writing
// ---------------------------------------------------------------------------

const writeIndex = async (index: TrailerIndex): Promise<Result<string>> => {
  const indexPathResult = await getIndexPath();
  if (!indexPathResult.ok) return indexPathResult;

  try {
    await Deno.writeTextFile(
      indexPathResult.value,
      JSON.stringify(index, null, 2),
    );
    return Result.ok(indexPathResult.value);
  } catch (e) {
    return Result.fail(e as Error);
  }
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  const args = Deno.args;
  const isCheck = args.includes("--check");

  if (isCheck) {
    const result = await checkFreshness();
    if (!result.ok) {
      console.error(`Error: ${result.error.message}`);
      Deno.exit(1);
    }

    if (result.value.fresh) {
      console.log("Trailer index is fresh");
    } else {
      console.log("Trailer index is stale or missing");
      Deno.exit(1);
    }
    return;
  }

  // Default: build
  console.log("Building trailer index...");

  const result = await buildIndex();
  if (!result.ok) {
    console.error(`Error: ${result.error.message}`);
    Deno.exit(1);
  }

  const index = result.value;
  const writeResult = await writeIndex(index);
  if (!writeResult.ok) {
    console.error(`Error writing index: ${writeResult.error.message}`);
    Deno.exit(1);
  }

  console.log(`Trailer index built successfully`);
  console.log(`  Commits indexed: ${index.commitCount}`);
  console.log(`  Intents: ${Object.keys(index.byIntent).length} types`);
  console.log(`  Scopes: ${Object.keys(index.byScope).length} unique`);
  console.log(`  Sessions: ${Object.keys(index.bySession).length} unique`);
  console.log(`  With decided-against: ${index.withDecidedAgainst.length}`);
  console.log(`  Written to: ${writeResult.value}`);
};

if (import.meta.main) {
  main();
}
