/**
 * Git Commit-Graph Maintenance - CLI
 *
 * Wraps `git commit-graph write` and `git commit-graph verify` to maintain
 * the binary acceleration structure that speeds up path-based queries
 * (via changed-paths Bloom filters) and ancestry/reachability checks.
 *
 * Usage:
 *   deno run --allow-run --allow-read scripts/maintain-commit-graph.ts [options]
 *
 * Options:
 *   --verify    Run `git commit-graph verify` instead of writing
 *   --stats     Print stats about the existing commit-graph file
 */

import { Result } from "./types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GraphStats {
  readonly exists: boolean;
  readonly fileSize: number;
  readonly commitCount: number | null;
  readonly changedPaths: boolean;
}

interface WriteResult {
  readonly success: boolean;
  readonly message: string;
  readonly stats: GraphStats;
}

interface VerifyResult {
  readonly valid: boolean;
  readonly message: string;
}

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

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

const getGraphStats = async (gitDir: string): Promise<GraphStats> => {
  const graphPath = `${gitDir}/objects/info/commit-graph`;

  try {
    const stat = await Deno.stat(graphPath);
    const fileSize = stat.size;

    // Count commits in graph via git log with generation numbers
    const countResult = await execGit([
      "rev-list", "--count", "--all",
    ]);
    const commitCount = countResult.ok
      ? parseInt(countResult.value.trim(), 10)
      : null;

    // Check if changed-paths Bloom filters are present by inspecting
    // the graph file header. The BDAT and BIDX chunks indicate Bloom data.
    let changedPaths = false;
    try {
      const file = await Deno.open(graphPath, { read: true });
      const header = new Uint8Array(256);
      await file.read(header);
      file.close();
      const headerStr = new TextDecoder("ascii").decode(header);
      changedPaths = headerStr.includes("BDAT") || headerStr.includes("BIDX");
    } catch {
      // If we can't read the header, assume no changed-paths
    }

    return { exists: true, fileSize, commitCount, changedPaths };
  } catch {
    return { exists: false, fileSize: 0, commitCount: null, changedPaths: false };
  }
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export const writeCommitGraph = async (): Promise<Result<WriteResult>> => {
  const gitDirResult = await getGitDir();
  if (!gitDirResult.ok) return gitDirResult as Result<never>;

  const writeResult = await execGit([
    "commit-graph", "write", "--reachable", "--changed-paths",
  ]);

  if (!writeResult.ok) {
    return Result.fail(writeResult.error);
  }

  const stats = await getGraphStats(gitDirResult.value);

  return Result.ok({
    success: true,
    message: "Commit-graph written successfully",
    stats,
  });
};

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

export const verifyCommitGraph = async (): Promise<Result<VerifyResult>> => {
  const result = await execGit(["commit-graph", "verify"]);

  if (!result.ok) {
    return Result.ok({
      valid: false,
      message: result.error.message,
    });
  }

  return Result.ok({
    valid: true,
    message: "Commit-graph integrity verified",
  });
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  const args = Deno.args;
  const isVerify = args.includes("--verify");
  const isStats = args.includes("--stats");

  if (isVerify) {
    const result = await verifyCommitGraph();
    if (!result.ok) {
      console.error(`Error: ${result.error.message}`);
      Deno.exit(1);
    }

    if (result.value.valid) {
      console.log(result.value.message);
    } else {
      console.error(`Verification failed: ${result.value.message}`);
      Deno.exit(1);
    }
    return;
  }

  if (isStats) {
    const gitDirResult = await getGitDir();
    if (!gitDirResult.ok) {
      console.error(`Error: ${gitDirResult.error.message}`);
      Deno.exit(1);
    }

    const stats = await getGraphStats(gitDirResult.value);
    if (!stats.exists) {
      console.log("No commit-graph found. Run without --stats to create one.");
      return;
    }

    console.log(`Commit-graph stats:`);
    console.log(`  File size: ${formatBytes(stats.fileSize)}`);
    if (stats.commitCount !== null) {
      console.log(`  Reachable commits: ${stats.commitCount}`);
    }
    console.log(`  Changed-paths Bloom filters: ${stats.changedPaths ? "yes" : "no"}`);
    return;
  }

  // Default: write
  const result = await writeCommitGraph();
  if (!result.ok) {
    console.error(`Error: ${result.error.message}`);
    Deno.exit(1);
  }

  const { stats } = result.value;
  console.log(result.value.message);
  console.log(`  File size: ${formatBytes(stats.fileSize)}`);
  if (stats.commitCount !== null) {
    console.log(`  Reachable commits: ${stats.commitCount}`);
  }
  console.log(`  Changed-paths Bloom filters: ${stats.changedPaths ? "yes" : "no"}`);
};

if (import.meta.main) {
  main();
}
