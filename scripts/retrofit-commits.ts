/**
 * RLM Git Commit Retrofit Utility
 *
 * Generates structured commit messages for existing unstructured commits
 * by extracting minimal commit information and using Claude to reformat.
 *
 * Usage:
 *   deno run --allow-read --allow-run --allow-write --allow-env --allow-net scripts/retrofit-commits.ts [options]
 *
 * Options:
 *   --limit=N           Max commits to process (default: all)
 *   --since=DATE        Git --since filter
 *   --output=FILE       Write report to file (default: stdout)
 *   --delay=MS          Delay between API calls in ms (default: 500)
 *   --resume            Skip commits already in cache
 *   --dry-run           Show extracts without calling API
 *   --format=md|json    Output format (default: md)
 *   --model=MODEL       Claude model (default: claude-sonnet-4-5-20250929)
 *   --apply             Rewrite git history with validated generated messages
 *   --force             Skip confirmation prompt (only meaningful with --apply)
 */

import type { CommitExtract, Diagnostic, RetrofitResult } from "./types.ts";
import { Result } from "./types.ts";
import { validate } from "./lib/validator.ts";
import { callClaude } from "./lib/llm.ts";
import { buildRetryPrompt, buildSystemPrompt, buildUserPrompt } from "./lib/prompt.ts";
import { loadCache, saveCache } from "./lib/cache.ts";

// ---------------------------------------------------------------------------
// CLI Options
// ---------------------------------------------------------------------------

interface CliOptions {
  readonly limit: number | null;
  readonly since: string | null;
  readonly output: string | null;
  readonly delay: number;
  readonly resume: boolean;
  readonly dryRun: boolean;
  readonly format: "md" | "json";
  readonly model: string | null;
  readonly apply: boolean;
  readonly force: boolean;
}

const DEFAULT_CACHE_PATH = ".retrofit-cache.json";

const parseCliArgs = (args: string[]): CliOptions => {
  const get = (key: string): string | null => {
    const arg = args.find((a) => a.startsWith(`--${key}=`));
    return arg ? arg.split("=").slice(1).join("=") : null;
  };

  const has = (key: string): boolean => args.includes(`--${key}`);

  const formatRaw = get("format");
  const format = formatRaw === "json" ? "json" : "md";

  const limitRaw = get("limit");
  let limit: number | null = null;
  if (limitRaw !== null) {
    limit = parseInt(limitRaw, 10);
    if (Number.isNaN(limit) || limit <= 0) {
      console.error(`Invalid --limit value: "${limitRaw}". Must be a positive integer.`);
      Deno.exit(2);
    }
  }

  const delayRaw = get("delay");
  let delayMs = 500;
  if (delayRaw !== null) {
    delayMs = parseInt(delayRaw, 10);
    if (Number.isNaN(delayMs) || delayMs < 0) {
      console.error(`Invalid --delay value: "${delayRaw}". Must be a non-negative integer.`);
      Deno.exit(2);
    }
  }

  return {
    limit,
    since: get("since"),
    output: get("output"),
    delay: delayMs,
    resume: has("resume"),
    dryRun: has("dry-run"),
    format,
    model: get("model"),
    apply: has("apply"),
    force: has("force"),
  };
};

// ---------------------------------------------------------------------------
// Git Extraction
// ---------------------------------------------------------------------------

const COMMIT_DELIMITER = "---commit-extract---";
const MESSAGE_START = "---message---";
const MESSAGE_END = "---endmessage---";
const STAT_START = "---stat---";

const buildGitArgs = (options: CliOptions): string[] => {
  const args = [
    "log",
    "--reverse",
    `--format=${COMMIT_DELIMITER}%nHash: %H%nDate: %aI%nAuthor: %an%n${MESSAGE_START}%n%B${MESSAGE_END}%n${STAT_START}`,
    "--stat",
    "--shortstat",
  ];

  if (options.limit !== null) args.push(`-${options.limit}`);
  if (options.since) args.push(`--since=${options.since}`);

  return args;
};

const parseExtract = (block: string): Result<CommitExtract> => {
  const hashMatch = /^Hash: (.+)$/m.exec(block);
  const dateMatch = /^Date: (.+)$/m.exec(block);
  const authorMatch = /^Author: (.+)$/m.exec(block);

  if (!hashMatch || !dateMatch || !authorMatch) {
    return Result.fail(new Error("Missing required fields in commit block"));
  }

  const msgStart = block.indexOf(MESSAGE_START);
  const msgEnd = block.indexOf(MESSAGE_END);
  const message = msgStart >= 0 && msgEnd > msgStart
    ? block.slice(msgStart + MESSAGE_START.length + 1, msgEnd).trim()
    : "";

  const statStart = block.indexOf(STAT_START);
  let stat = "";
  let shortstat = "";
  if (statStart >= 0) {
    const statBlock = block.slice(statStart + STAT_START.length).trim();
    const statLines = statBlock.split("\n").filter((l) => l.trim().length > 0);

    // The last line with "insertions"/"deletions"/"changed" is the shortstat
    const shortstatIdx = statLines.findLastIndex((l) =>
      /\d+ files? changed/.test(l)
    );
    if (shortstatIdx >= 0) {
      shortstat = statLines[shortstatIdx].trim();
      stat = statLines.slice(0, shortstatIdx).join("\n").trim();
    } else {
      stat = statLines.join("\n").trim();
    }
  }

  return Result.ok({
    hash: hashMatch[1],
    date: dateMatch[1],
    author: authorMatch[1],
    message,
    stat,
    shortstat,
  });
};

const extractCommits = async (
  options: CliOptions,
): Promise<Result<readonly CommitExtract[]>> => {
  const args = buildGitArgs(options);

  try {
    const command = new Deno.Command("git", {
      args,
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();

    if (!output.success) {
      const stderr = new TextDecoder().decode(output.stderr);
      return Result.fail(new Error(`git log failed: ${stderr}`));
    }

    const raw = new TextDecoder().decode(output.stdout);
    const blocks = raw.split(COMMIT_DELIMITER).filter((b) => b.trim().length > 0);

    const extracts: CommitExtract[] = [];
    const errors: string[] = [];

    for (const block of blocks) {
      const result = parseExtract(block);
      if (result.ok) {
        extracts.push(result.value);
      } else {
        errors.push(result.error.message);
      }
    }

    if (errors.length > 0) {
      console.error(`Warning: ${errors.length} commit(s) could not be parsed`);
    }

    return Result.ok(extracts);
  } catch (e) {
    return Result.fail(e instanceof Error ? e : new Error(String(e)));
  }
};

// ---------------------------------------------------------------------------
// Reference Docs
// ---------------------------------------------------------------------------

const loadRefDoc = (path: string): Result<string> => {
  try {
    return Result.ok(Deno.readTextFileSync(path));
  } catch (e) {
    return Result.fail(e instanceof Error ? e : new Error(String(e)));
  }
};

const findReferenceDocs = (): Result<{ formatSpec: string; taxonomy: string }> => {
  // Try relative to script location first, then cwd
  const paths = [
    ["skills/git-structure-commits/references/commit-format.md",
     "skills/git-structure-commits/references/intent-taxonomy.md"],
  ];

  for (const [formatPath, taxonomyPath] of paths) {
    const formatResult = loadRefDoc(formatPath);
    const taxonomyResult = loadRefDoc(taxonomyPath);
    if (formatResult.ok && taxonomyResult.ok) {
      return Result.ok({
        formatSpec: formatResult.value,
        taxonomy: taxonomyResult.value,
      });
    }
  }

  return Result.fail(
    new Error("Could not find reference docs (commit-format.md, intent-taxonomy.md)"),
  );
};

// ---------------------------------------------------------------------------
// Processing Pipeline
// ---------------------------------------------------------------------------

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const processCommit = async (
  extract: CommitExtract,
  systemPrompt: string,
  apiKey: string,
  model: string | null,
  cache: Record<string, string>,
  resume: boolean,
): Promise<RetrofitResult> => {
  // Check cache
  if (resume && cache[extract.hash]) {
    const generated = cache[extract.hash];
    const diagnostics = validate(generated);
    return {
      extract,
      generated,
      diagnostics,
      retried: false,
      cached: true,
      error: null,
    };
  }

  // First attempt
  const userPrompt = buildUserPrompt(extract);
  const firstResult = await callClaude({
    system: systemPrompt,
    user: userPrompt,
    apiKey,
    ...(model ? { model } : {}),
  });

  if (!firstResult.ok) {
    return {
      extract,
      generated: null,
      diagnostics: [],
      retried: false,
      cached: false,
      error: firstResult.error.message,
    };
  }

  const firstMessage = firstResult.value;
  const firstDiagnostics = validate(firstMessage);
  const hasErrors = firstDiagnostics.some((d) => d.severity === "error");

  // Retry if validation errors
  if (hasErrors) {
    const retryPrompt = buildRetryPrompt(extract, firstDiagnostics);
    const retryResult = await callClaude({
      system: systemPrompt,
      user: retryPrompt,
      apiKey,
      ...(model ? { model } : {}),
    });

    if (!retryResult.ok) {
      // Return first attempt with its diagnostics
      cache[extract.hash] = firstMessage;
      return {
        extract,
        generated: firstMessage,
        diagnostics: firstDiagnostics,
        retried: true,
        cached: false,
        error: `Retry failed: ${retryResult.error.message}`,
      };
    }

    const retryMessage = retryResult.value;
    const retryDiagnostics = validate(retryMessage);
    cache[extract.hash] = retryMessage;
    return {
      extract,
      generated: retryMessage,
      diagnostics: retryDiagnostics,
      retried: true,
      cached: false,
      error: null,
    };
  }

  cache[extract.hash] = firstMessage;
  return {
    extract,
    generated: firstMessage,
    diagnostics: firstDiagnostics,
    retried: false,
    cached: false,
    error: null,
  };
};

// ---------------------------------------------------------------------------
// Output Formatting
// ---------------------------------------------------------------------------

const classifyResult = (
  result: RetrofitResult,
): "pass" | "warnings" | "needs-review" | "error" => {
  if (result.error && !result.generated) return "error";
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  const warnings = result.diagnostics.filter((d) => d.severity === "warning");
  if (errors.length > 0) return "needs-review";
  if (warnings.length > 0) return "warnings";
  return "pass";
};

const formatMarkdownReport = (results: readonly RetrofitResult[]): string => {
  const now = new Date().toISOString().slice(0, 10);
  const passed = results.filter((r) => classifyResult(r) === "pass").length;
  const warnings = results.filter((r) => classifyResult(r) === "warnings").length;
  const needsReview = results.filter((r) => classifyResult(r) === "needs-review").length;
  const errored = results.filter((r) => classifyResult(r) === "error").length;

  const lines: string[] = [];
  lines.push("# Structured Commit Retrofit Report");
  lines.push("");
  lines.push(
    `Generated: ${now} | Commits: ${results.length} | Passed: ${passed} | Warnings: ${warnings} | Needs review: ${needsReview}${errored > 0 ? ` | Errors: ${errored}` : ""}`,
  );

  for (const result of results) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push(
      `## ${result.extract.hash.slice(0, 7)} - ${result.extract.date.slice(0, 10)}`,
    );
    lines.push("");
    lines.push("**Original:**");
    lines.push(result.extract.message);
    lines.push("");

    if (result.generated) {
      lines.push("**Generated:**");
      lines.push(result.generated);
      lines.push("");

      const status = classifyResult(result);
      const errorCount = result.diagnostics.filter((d) => d.severity === "error").length;
      const warnCount = result.diagnostics.filter((d) => d.severity === "warning").length;

      let statusText = status;
      if (warnCount > 0) statusText += ` (${warnCount} warning${warnCount > 1 ? "s" : ""})`;
      if (errorCount > 0) statusText += ` (${errorCount} error${errorCount > 1 ? "s" : ""})`;
      if (result.retried) statusText += " [retried]";
      if (result.cached) statusText += " [cached]";

      lines.push(`**Validation:** ${statusText}`);

      if (result.diagnostics.length > 0) {
        lines.push("");
        for (const d of result.diagnostics) {
          lines.push(`- [${d.severity}] ${d.rule}: ${d.message}`);
        }
      }
    } else if (result.error) {
      lines.push(`**Error:** ${result.error}`);
    }
  }

  lines.push("");
  return lines.join("\n");
};

const formatDryRun = (extracts: readonly CommitExtract[]): string => {
  const lines: string[] = [];
  lines.push(`# Dry Run: ${extracts.length} commit(s) extracted`);

  for (const extract of extracts) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push(`## ${extract.hash.slice(0, 7)} - ${extract.date.slice(0, 10)} (${extract.author})`);
    lines.push("");
    lines.push("**Message:**");
    lines.push(extract.message);
    lines.push("");
    if (extract.stat) {
      lines.push("**Stat:**");
      lines.push(extract.stat);
      lines.push("");
    }
    if (extract.shortstat) {
      lines.push(`**Shortstat:** ${extract.shortstat}`);
    }
  }

  lines.push("");
  return lines.join("\n");
};

const formatJsonReport = (results: readonly RetrofitResult[]): string =>
  JSON.stringify(results, null, 2);

// ---------------------------------------------------------------------------
// Apply to History
// ---------------------------------------------------------------------------

const isEligible = (result: RetrofitResult): boolean =>
  result.generated !== null &&
  result.diagnostics.every((d) => d.severity !== "error");

const applyToHistory = async (
  results: readonly RetrofitResult[],
  force: boolean,
): Promise<Result<number>> => {
  const eligible = results.filter(isEligible);

  if (eligible.length === 0) {
    console.error("No eligible commits to apply (all have errors or no generated message).");
    return Result.ok(0);
  }

  const firstHash = eligible[0].extract.hash.slice(0, 7);
  const lastHash = eligible[eligible.length - 1].extract.hash.slice(0, 7);

  if (!force) {
    console.error(
      `\nThis will rewrite ${eligible.length} commit(s) (${firstHash}..${lastHash}).` +
        "\nCommit hashes will change. Originals saved to refs/original/." +
        "\nContinue? [y/N] ",
    );

    const buf = new Uint8Array(64);
    const n = await Deno.stdin.read(buf);
    const answer = n !== null ? new TextDecoder().decode(buf.subarray(0, n)).trim() : "";
    if (answer.toLowerCase() !== "y") {
      console.error("Aborted.");
      return Result.ok(0);
    }
  }

  const tmpDir = Deno.makeTempDirSync({ prefix: "retrofit-apply-" });

  try {
    for (const result of eligible) {
      const filePath = `${tmpDir}/${result.extract.hash}`;
      Deno.writeTextFileSync(filePath, result.generated!);
    }

    const msgFilter =
      `if [ -f "${tmpDir}/$GIT_COMMIT" ]; then cat "${tmpDir}/$GIT_COMMIT"; else cat; fi`;

    const command = new Deno.Command("git", {
      args: ["filter-branch", "--msg-filter", msgFilter, "--", "--all"],
      stdout: "piped",
      stderr: "piped",
    });
    const output = await command.output();

    if (!output.success) {
      const stderr = new TextDecoder().decode(output.stderr);
      return Result.fail(new Error(`git filter-branch failed: ${stderr}`));
    }

    console.error(
      `\nRewrote ${eligible.length} commit(s). Original refs saved to refs/original/.`,
    );
    return Result.ok(eligible.length);
  } finally {
    try {
      Deno.removeSync(tmpDir, { recursive: true });
    } catch {
      // Best-effort cleanup
    }
  }
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  const options = parseCliArgs(Deno.args);

  // Extract commits from git log
  const extractResult = await extractCommits(options);
  if (!extractResult.ok) {
    console.error(`Error: ${extractResult.error.message}`);
    Deno.exit(1);
  }

  const extracts = extractResult.value;
  if (extracts.length === 0) {
    console.log("No commits found.");
    Deno.exit(0);
  }

  // Dry run: just show extracts
  if (options.dryRun) {
    const output = formatDryRun(extracts);
    if (options.output) {
      Deno.writeTextFileSync(options.output, output);
      console.log(`Dry run report written to ${options.output}`);
    } else {
      console.log(output);
    }
    Deno.exit(0);
  }

  // Load API key
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY environment variable is required");
    Deno.exit(1);
  }

  // Load reference docs
  const docsResult = findReferenceDocs();
  if (!docsResult.ok) {
    console.error(`Error: ${docsResult.error.message}`);
    Deno.exit(1);
  }

  const systemPrompt = buildSystemPrompt(
    docsResult.value.formatSpec,
    docsResult.value.taxonomy,
  );

  // Load cache
  const cacheResult = loadCache(DEFAULT_CACHE_PATH);
  if (!cacheResult.ok) {
    console.error(`Warning: Could not load cache: ${cacheResult.error.message}`);
  }
  const cache = cacheResult.ok ? cacheResult.value : {};

  // Process commits
  const results: RetrofitResult[] = [];
  let processed = 0;

  for (const extract of extracts) {
    processed++;
    const shortHash = extract.hash.slice(0, 7);
    const isCached = options.resume && cache[extract.hash] !== undefined;

    console.error(
      `[${processed}/${extracts.length}] ${shortHash}${isCached ? " (cached)" : ""}`,
    );

    const result = await processCommit(
      extract,
      systemPrompt,
      apiKey,
      options.model,
      cache,
      options.resume,
    );
    results.push(result);

    // Save cache after each commit for resume support
    saveCache(cache, DEFAULT_CACHE_PATH);

    // Delay between API calls (skip for cached)
    if (!result.cached && processed < extracts.length) {
      const totalDelay = result.retried ? options.delay * 2 : options.delay;
      await delay(totalDelay);
    }
  }

  // Format output
  const output = options.format === "json"
    ? formatJsonReport(results)
    : formatMarkdownReport(results);

  if (options.output) {
    Deno.writeTextFileSync(options.output, output);
    console.error(`Report written to ${options.output}`);
  } else {
    console.log(output);
  }

  // Summary to stderr
  const passed = results.filter((r) => classifyResult(r) === "pass").length;
  const warns = results.filter((r) => classifyResult(r) === "warnings").length;
  const review = results.filter((r) => classifyResult(r) === "needs-review").length;
  const errored = results.filter((r) => classifyResult(r) === "error").length;

  console.error(
    `\nDone: ${passed} passed, ${warns} warnings, ${review} needs review, ${errored} errors`,
  );

  if (options.apply) {
    const applyResult = await applyToHistory(results, options.force);
    if (!applyResult.ok) {
      console.error(`Error applying to history: ${applyResult.error.message}`);
      Deno.exit(1);
    }
  }
};

main();
