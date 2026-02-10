/**
 * Git Memory Context - UserPromptSubmit Hook
 *
 * Produces a compact summary of git history context, injected automatically
 * before every Claude prompt via the UserPromptSubmit hook.
 *
 * Three modes:
 *   - llm-enhanced: uses a local LLM (Ollama) for smart prompt analysis,
 *     recursive follow-up queries, and context summarization
 *   - prompt-aware: keyword-based scope/intent extraction from the prompt
 *   - recency: falls back to the N most recent commits when no signals match
 *
 * Design:
 *   - LLM path: loads RLM config, analyzes prompt with LLM, generates
 *     follow-up queries, merges results, optionally summarizes. Falls back
 *     to keyword path on any LLM failure.
 *   - Primary path: loads trailer index via loadIndex() (pure file I/O),
 *     matches prompt signals against index scope keys
 *   - Fallback path: runs git log + parseCommitBlock for recent commits
 *   - Exits 0 with empty string on any error (never blocks the user)
 *
 * Usage:
 *   deno run --allow-run --allow-read --allow-env --allow-net scripts/git-memory-context.ts
 */

import type { IndexedCommit, TrailerIndex } from "./types.ts";
import { Result } from "./types.ts";
import { loadIndex } from "./build-trailer-index.ts";
import { parseCommitBlock } from "./lib/parser.ts";
import {
  extractPromptSignals,
  type PromptSignals,
} from "./lib/prompt-analyzer.ts";
import { scopeMatches, wordBoundaryMatch } from "./lib/matching.ts";
import {
  formatWorkingMemory,
  loadWorkingMemory,
} from "./lib/working-memory.ts";
import { loadRlmConfig } from "./lib/rlm-config.ts";
import {
  analyzePromptWithLlm,
  type FollowUpQuery,
  generateFollowUpQueries,
  type LlmPromptSignals,
  summarizeContext,
} from "./lib/rlm-subcalls.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RECENT_COMMITS = 10;
const MAX_DECISIONS = 20;
const MAX_PROMPT_AWARE_COMMITS = 15;
const MAX_PROMPT_AWARE_DECISIONS = 10;

interface BenchTraceLatencies {
  readonly total: number;
  readonly analyzePrompt?: number;
  readonly generateFollowUps?: number;
  readonly summarizeContext?: number;
}

interface BenchTraceRecord {
  readonly timestamp: string;
  readonly prompt: string;
  readonly promptId: string | null;
  readonly runId: string | null;
  readonly mode: "prompt-aware" | "recency" | "llm-enhanced";
  readonly configuredModel: string | null;
  readonly llmSignals?: LlmPromptSignals;
  readonly promptSignals?: PromptSignals;
  readonly followUpQueries?: readonly FollowUpQuery[];
  readonly initialHashes: readonly string[];
  readonly followUpAddedHashes: readonly string[];
  readonly finalHashes: readonly string[];
  readonly decisionsCount: number;
  readonly latenciesMs: BenchTraceLatencies;
}

// ---------------------------------------------------------------------------
// Stdin Reading
// ---------------------------------------------------------------------------

const readPrompt = async (): Promise<string> => {
  try {
    if (Deno.stdin.isTerminal()) return "";
    const buf = new Uint8Array(65536);
    const n = await Deno.stdin.read(buf);
    if (n === null) return "";
    const text = new TextDecoder().decode(buf.subarray(0, n));
    const parsed = JSON.parse(text);
    return typeof parsed?.prompt === "string" ? parsed.prompt : "";
  } catch {
    // Drain remaining stdin on parse error
    try {
      if (!Deno.stdin.isTerminal()) {
        await Deno.stdin.readable.cancel();
      }
    } catch {
      // ignore
    }
    return "";
  }
};

const isBenchTraceEnabled = (): boolean => {
  const raw = (Deno.env.get("RLM_BENCH_TRACE") ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
};

const getBenchTracePath = (): string =>
  Deno.env.get("RLM_BENCH_TRACE_FILE") ?? ".git/info/rlm-benchmark-trace.jsonl";

const appendBenchTrace = async (record: BenchTraceRecord): Promise<void> => {
  if (!isBenchTraceEnabled()) return;

  try {
    const path = getBenchTracePath();
    const slash = path.lastIndexOf("/");
    const dir = slash >= 0 ? path.slice(0, slash) : ".";
    await Deno.mkdir(dir, { recursive: true });
    const line = `${JSON.stringify(record)}\n`;
    await Deno.writeTextFile(path, line, { append: true, create: true });
  } catch {
    // Bench tracing must never interfere with hook behavior.
  }
};

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
  readonly mode: "prompt-aware" | "recency" | "llm-enhanced";
  readonly recentCommits: readonly {
    readonly hash: string;
    readonly subject: string;
    readonly scope: readonly string[];
  }[];
  readonly decisions: readonly DecisionEntry[];
  readonly session:
    | { readonly id: string; readonly commitCount: number }
    | null;
  readonly summary?: string;
}

interface LlmPathResult {
  readonly data: ContextData;
  readonly trace: {
    readonly model: string;
    readonly llmSignals: LlmPromptSignals;
    readonly followUpQueries: readonly FollowUpQuery[];
    readonly initialHashes: readonly string[];
    readonly followUpAddedHashes: readonly string[];
    readonly finalHashes: readonly string[];
    readonly latenciesMs: BenchTraceLatencies;
  };
}

// ---------------------------------------------------------------------------
// Prompt-Aware Extraction from Index
// ---------------------------------------------------------------------------

const extractRelevantFromIndex = (
  index: TrailerIndex,
  signals: PromptSignals,
): ContextData | null => {
  const hasSignals = signals.scopeHints.length > 0 ||
    signals.intentHints.length > 0 ||
    signals.keywords.length > 0;

  if (!hasSignals) return null;

  // Collect candidate hashes from scope matches
  const candidateHashes = new Set<string>();

  for (const scopeHint of signals.scopeHints) {
    for (const [scopeKey, hashes] of Object.entries(index.byScope)) {
      if (scopeMatches(scopeKey, scopeHint)) {
        for (const h of hashes) candidateHashes.add(h);
      }
    }
  }

  // Collect candidate hashes from intent matches
  for (const intent of signals.intentHints) {
    const hashes = index.byIntent[intent];
    if (hashes) {
      for (const h of hashes) candidateHashes.add(h);
    }
  }

  // If we got no candidates from scope/intent, fall back
  if (candidateHashes.size === 0) return null;

  // Resolve to IndexedCommit objects, sort by date descending
  const commits: IndexedCommit[] = [];
  for (const hash of candidateHashes) {
    const commit = index.commits[hash];
    if (commit) commits.push(commit);
  }
  commits.sort((a, b) => b.date.localeCompare(a.date));

  const recentCommits = commits
    .slice(0, MAX_PROMPT_AWARE_COMMITS)
    .map((c) => ({
      hash: c.hash,
      subject: c.subject,
      scope: c.scope,
    }));

  // Collect decisions relevant to the prompt: scope-matched + keyword-matched
  const decisions: DecisionEntry[] = [];
  for (const hash of index.withDecidedAgainst) {
    if (decisions.length >= MAX_PROMPT_AWARE_DECISIONS) break;
    const commit = index.commits[hash];
    if (!commit) continue;

    // Check if this decision is in a relevant scope
    const scopeRelevant = signals.scopeHints.some((hint) =>
      commit.scope.some((s) => scopeMatches(s, hint))
    );

    for (const text of commit.decidedAgainst) {
      if (decisions.length >= MAX_PROMPT_AWARE_DECISIONS) break;

      // Include if scope-relevant or keyword matches the decision text
      const keywordRelevant = signals.keywords.some((kw) =>
        wordBoundaryMatch(text, kw)
      );

      if (scopeRelevant || keywordRelevant) {
        decisions.push({ scope: commit.scope, text });
      }
    }
  }

  const sessionId = Deno.env.get("STRUCTURED_GIT_SESSION") ?? null;
  let session: ContextData["session"] = null;
  if (sessionId && index.bySession[sessionId]) {
    session = {
      id: sessionId,
      commitCount: index.bySession[sessionId].length,
    };
  }

  return { mode: "prompt-aware", recentCommits, decisions, session };
};

// ---------------------------------------------------------------------------
// Recency Extraction from Index (original behavior)
// ---------------------------------------------------------------------------

const extractFromIndex = (index: TrailerIndex): ContextData => {
  const allCommits = Object.values(index.commits) as IndexedCommit[];
  const sorted = allCommits
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, MAX_RECENT_COMMITS);

  const recentCommits = sorted.map((c) => ({
    hash: c.hash,
    subject: c.subject,
    scope: c.scope,
  }));

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

  const sessionId = Deno.env.get("STRUCTURED_GIT_SESSION") ?? null;
  let session: ContextData["session"] = null;
  if (sessionId && index.bySession[sessionId]) {
    session = {
      id: sessionId,
      commitCount: index.bySession[sessionId].length,
    };
  }

  return { mode: "recency", recentCommits, decisions, session };
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
    .filter((
      r,
    ): r is { ok: true; value: import("./types.ts").StructuredCommit } => r.ok)
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

  return Result.ok({ mode: "recency", recentCommits, decisions, session });
};

// ---------------------------------------------------------------------------
// Output Formatting
// ---------------------------------------------------------------------------

const formatContext = (data: ContextData): string => {
  if (data.recentCommits.length === 0 && !data.summary) return "";

  const lines: string[] = [];

  // LLM summary replaces the raw listing when present
  if (data.summary) {
    lines.push(data.summary);
  } else {
    // Decisions section
    if (data.decisions.length > 0) {
      lines.push("Recent decisions (decided-against):");
      for (const d of data.decisions) {
        const scopeLabel = d.scope.length > 0 ? `[${d.scope.join(", ")}] ` : "";
        lines.push(`- ${scopeLabel}${d.text}`);
      }
      lines.push("");
    }

    // Recent commits section
    lines.push("Recent commits:");
    for (const c of data.recentCommits) {
      const scopeSuffix = c.scope.length > 0 ? ` | ${c.scope.join(", ")}` : "";
      lines.push(`${c.hash.slice(0, 7)} ${c.subject}${scopeSuffix}`);
    }
  }

  // Session section
  if (data.session) {
    lines.push("");
    lines.push(
      `Session: ${data.session.id} (${data.session.commitCount} commit${
        data.session.commitCount === 1 ? "" : "s"
      })`,
    );
  }

  return `<git-memory-context mode="${data.mode}">\n${
    lines.join("\n")
  }\n</git-memory-context>`;
};

// ---------------------------------------------------------------------------
// LLM-Enhanced Path
// ---------------------------------------------------------------------------

/**
 * Convert LLM prompt signals to the PromptSignals format used by
 * extractRelevantFromIndex. LLM scopes map to scopeHints, LLM intents
 * map to intentHints, and LLM keywords map to keywords.
 */
const llmSignalsToPromptSignals = (llm: LlmPromptSignals): PromptSignals => ({
  scopeHints: llm.scopes as string[],
  intentHints: llm.intents as import("./types.ts").IntentType[],
  keywords: llm.keywords as string[],
});

/**
 * Build a text representation of ContextData for the LLM summarizer
 * and follow-up query generator.
 */
const contextToText = (data: ContextData): string => {
  const parts: string[] = [];

  for (const c of data.recentCommits) {
    const scopeSuffix = c.scope.length > 0 ? ` [${c.scope.join(", ")}]` : "";
    parts.push(`${c.hash.slice(0, 7)} ${c.subject}${scopeSuffix}`);
  }

  for (const d of data.decisions) {
    const scopeLabel = d.scope.length > 0 ? `[${d.scope.join(", ")}] ` : "";
    parts.push(`decided-against: ${scopeLabel}${d.text}`);
  }

  return parts.join("\n");
};

/**
 * Execute follow-up queries against the index and return additional commits
 * not already present in the initial set.
 */
const executeFollowUpQueries = (
  index: TrailerIndex,
  queries: readonly FollowUpQuery[],
  existingHashes: ReadonlySet<string>,
): readonly IndexedCommit[] => {
  const additional: IndexedCommit[] = [];
  const seen = new Set(existingHashes);

  for (const query of queries) {
    // Collect hashes matching this query
    const candidateHashes = new Set<string>();

    if (query.scope) {
      for (const [scopeKey, hashes] of Object.entries(index.byScope)) {
        if (scopeMatches(scopeKey, query.scope)) {
          for (const h of hashes) candidateHashes.add(h);
        }
      }
    }

    if (query.intent) {
      const hashes = index.byIntent[query.intent];
      if (hashes) {
        if (candidateHashes.size > 0) {
          // Intersect with scope results
          for (const h of candidateHashes) {
            if (!hashes.includes(h)) candidateHashes.delete(h);
          }
        } else {
          for (const h of hashes) candidateHashes.add(h);
        }
      }
    }

    if (query.decidedAgainst) {
      const keyword = query.decidedAgainst;
      for (const hash of index.withDecidedAgainst) {
        const commit = index.commits[hash];
        if (!commit) continue;
        if (commit.decidedAgainst.some((d) => wordBoundaryMatch(d, keyword))) {
          candidateHashes.add(hash);
        }
      }
    }

    // Add only new commits
    for (const hash of candidateHashes) {
      if (seen.has(hash)) continue;
      seen.add(hash);
      const commit = index.commits[hash];
      if (commit) additional.push(commit);
    }
  }

  return additional;
};

/**
 * Try the LLM-enhanced path. Returns ContextData on success, null on any
 * LLM failure (caller should fall through to keyword path).
 */
const tryLlmEnhancedPath = async (
  index: TrailerIndex,
  prompt: string,
  scopeKeys: readonly string[],
): Promise<LlmPathResult | null> => {
  const totalStart = performance.now();
  const config = await loadRlmConfig();
  if (!config.enabled) return null;

  // Step 1: LLM prompt analysis
  const analyzeStart = performance.now();
  const analysisResult = await analyzePromptWithLlm(config, prompt, scopeKeys);
  const analyzeMs = performance.now() - analyzeStart;
  if (!analysisResult.ok) return null;

  const llmSignals = analysisResult.value;
  const hasSignals = llmSignals.scopes.length > 0 ||
    llmSignals.intents.length > 0 ||
    llmSignals.keywords.length > 0;
  if (!hasSignals) return null;

  // Step 2: Extract from index using LLM signals
  const signals = llmSignalsToPromptSignals(llmSignals);
  const initialData = extractRelevantFromIndex(index, signals);
  if (!initialData) return null;
  const initialHashes = initialData.recentCommits.map((c) => c.hash);

  // Step 3: Generate follow-up queries
  const initialText = contextToText(initialData);
  const validScopes = new Set(scopeKeys);
  const followUpStart = performance.now();
  const followUpResult = await generateFollowUpQueries(
    config,
    prompt,
    initialText,
    validScopes,
  );
  const followUpMs = performance.now() - followUpStart;

  // Merge follow-up results (if follow-up generation fails, use initial data)
  let mergedCommits = [...initialData.recentCommits];
  let mergedDecisions = [...initialData.decisions];
  const followUpQueries = followUpResult.ok ? followUpResult.value : [];
  const followUpAddedHashes: string[] = [];

  if (followUpQueries.length > 0) {
    const existingHashes = new Set(
      initialData.recentCommits.map((c) => c.hash),
    );
    const additionalCommits = executeFollowUpQueries(
      index,
      followUpQueries,
      existingHashes,
    );

    // Add additional commits
    for (const c of additionalCommits) {
      followUpAddedHashes.push(c.hash);
      mergedCommits.push({
        hash: c.hash,
        subject: c.subject,
        scope: c.scope,
      });
    }

    // Add additional decisions from follow-up decided-against queries
    for (const query of followUpQueries) {
      if (!query.decidedAgainst) continue;
      for (const hash of index.withDecidedAgainst) {
        if (mergedDecisions.length >= MAX_PROMPT_AWARE_DECISIONS) break;
        const commit = index.commits[hash];
        if (!commit) continue;
        for (const text of commit.decidedAgainst) {
          if (mergedDecisions.length >= MAX_PROMPT_AWARE_DECISIONS) break;
          if (wordBoundaryMatch(text, query.decidedAgainst)) {
            const alreadyPresent = mergedDecisions.some((d) => d.text === text);
            if (!alreadyPresent) {
              mergedDecisions.push({ scope: commit.scope, text });
            }
          }
        }
      }
    }

    // Cap merged results
    mergedCommits = mergedCommits.slice(0, MAX_PROMPT_AWARE_COMMITS);
    mergedDecisions = mergedDecisions.slice(0, MAX_PROMPT_AWARE_DECISIONS);
  }

  // Step 4: Summarize context (optional, failure uses raw context)
  let mergedData: ContextData = {
    mode: "llm-enhanced",
    recentCommits: mergedCommits,
    decisions: mergedDecisions,
    session: initialData.session,
  };

  const mergedText = contextToText(mergedData);
  const summarizeStart = performance.now();
  const summaryResult = await summarizeContext(config, prompt, mergedText);
  const summarizeMs = performance.now() - summarizeStart;

  if (summaryResult.ok) {
    mergedData = { ...mergedData, summary: summaryResult.value };
  }

  const finalHashes = mergedData.recentCommits.map((c) => c.hash);
  const totalMs = performance.now() - totalStart;

  return {
    data: mergedData,
    trace: {
      model: config.model,
      llmSignals,
      followUpQueries,
      initialHashes,
      followUpAddedHashes,
      finalHashes,
      latenciesMs: {
        total: totalMs,
        analyzePrompt: analyzeMs,
        generateFollowUps: followUpMs,
        summarizeContext: summarizeMs,
      },
    },
  };
};

// ---------------------------------------------------------------------------
// Working Memory Injection
// ---------------------------------------------------------------------------

const getWorkingMemoryBlock = async (): Promise<string> => {
  const sessionId = Deno.env.get("STRUCTURED_GIT_SESSION") ?? null;
  if (!sessionId) return "";

  const result = await loadWorkingMemory(sessionId);
  if (!result.ok || !result.value) return "";

  return formatWorkingMemory(result.value);
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const emitContext = async (data: ContextData): Promise<void> => {
  const output = formatContext(data);
  if (output) console.log(output);
  const wmBlock = await getWorkingMemoryBlock();
  if (wmBlock) console.log(wmBlock);
};

const main = async (): Promise<void> => {
  const totalStart = performance.now();
  // Read the user's prompt from stdin JSON
  const prompt = await readPrompt();
  const promptId = Deno.env.get("RLM_BENCH_PROMPT_ID") ?? null;
  const runId = Deno.env.get("RLM_BENCH_RUN_ID") ?? null;
  const configuredModel = isBenchTraceEnabled()
    ? (await loadRlmConfig()).model
    : null;

  // Try index path first (pure file I/O, no git subprocess)
  const indexResult = await loadIndex();
  if (indexResult.ok && indexResult.value !== null) {
    const index = indexResult.value;
    const scopeKeys = Object.keys(index.byScope);

    // Try LLM-enhanced path (falls back to null on any failure)
    const llmData = await tryLlmEnhancedPath(index, prompt, scopeKeys);
    if (llmData) {
      await emitContext(llmData.data);
      await appendBenchTrace({
        timestamp: new Date().toISOString(),
        prompt,
        promptId,
        runId,
        mode: "llm-enhanced",
        configuredModel: llmData.trace.model,
        llmSignals: llmData.trace.llmSignals,
        followUpQueries: llmData.trace.followUpQueries,
        initialHashes: llmData.trace.initialHashes,
        followUpAddedHashes: llmData.trace.followUpAddedHashes,
        finalHashes: llmData.trace.finalHashes,
        decisionsCount: llmData.data.decisions.length,
        latenciesMs: llmData.trace.latenciesMs,
      });
      return;
    }

    // Try keyword-based prompt-aware extraction
    const signals = extractPromptSignals(prompt, scopeKeys);
    const promptAwareData = extractRelevantFromIndex(index, signals);
    if (promptAwareData) {
      await emitContext(promptAwareData);
      await appendBenchTrace({
        timestamp: new Date().toISOString(),
        prompt,
        promptId,
        runId,
        mode: "prompt-aware",
        configuredModel,
        promptSignals: signals,
        initialHashes: promptAwareData.recentCommits.map((c) => c.hash),
        followUpAddedHashes: [],
        finalHashes: promptAwareData.recentCommits.map((c) => c.hash),
        decisionsCount: promptAwareData.decisions.length,
        latenciesMs: {
          total: performance.now() - totalStart,
        },
      });
      return;
    }

    // Fall back to recency mode
    const data = extractFromIndex(index);
    await emitContext(data);
    await appendBenchTrace({
      timestamp: new Date().toISOString(),
      prompt,
      promptId,
      runId,
      mode: "recency",
      configuredModel,
      initialHashes: data.recentCommits.map((c) => c.hash),
      followUpAddedHashes: [],
      finalHashes: data.recentCommits.map((c) => c.hash),
      decisionsCount: data.decisions.length,
      latenciesMs: {
        total: performance.now() - totalStart,
      },
    });
    return;
  }

  // Fallback: git log + parse (prompt-unaware since we lack scope keys)
  const fallbackResult = await extractFromGitLog();
  if (fallbackResult.ok) {
    await emitContext(fallbackResult.value);
    await appendBenchTrace({
      timestamp: new Date().toISOString(),
      prompt,
      promptId,
      runId,
      mode: "recency",
      configuredModel,
      initialHashes: fallbackResult.value.recentCommits.map((c) => c.hash),
      followUpAddedHashes: [],
      finalHashes: fallbackResult.value.recentCommits.map((c) => c.hash),
      decisionsCount: fallbackResult.value.decisions.length,
      latenciesMs: {
        total: performance.now() - totalStart,
      },
    });
    return;
  }

  // Any error: exit silently with 0
};

if (import.meta.main) {
  main();
}
