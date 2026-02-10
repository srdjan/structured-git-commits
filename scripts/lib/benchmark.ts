/**
 * Shared types and helpers for benchmark scripts.
 */

import { Result } from "../types.ts";

export interface CommitLabel {
  readonly hash: string;
  readonly relevance: number; // 0-3
}

export interface PromptDatasetEntry {
  readonly prompt_id: string;
  readonly prompt: string;
  readonly commit_labels: readonly CommitLabel[];
  readonly must_include_hashes: readonly string[];
  readonly gold_facts: readonly string[];
}

export interface ContextBenchRun {
  readonly timestamp: string;
  readonly prompt_id: string;
  readonly prompt: string;
  readonly mode: "llm-enhanced" | "prompt-aware" | "recency";
  readonly model: string | null;
  readonly run: number;
  readonly run_id: string;
  readonly duration_ms: number;
  readonly exit_code: number;
  readonly context_mode: string | null;
  readonly context_block: string | null;
  readonly stderr: string;
}

export interface ContextBenchTrace {
  readonly timestamp: string;
  readonly prompt: string;
  readonly promptId: string | null;
  readonly runId: string | null;
  readonly mode: "prompt-aware" | "recency" | "llm-enhanced";
  readonly configuredModel: string | null;
  readonly llmSignals?: {
    readonly scopes: readonly string[];
    readonly intents: readonly string[];
    readonly keywords: readonly string[];
  };
  readonly promptSignals?: {
    readonly scopeHints: readonly string[];
    readonly intentHints: readonly string[];
    readonly keywords: readonly string[];
  };
  readonly followUpQueries?: readonly {
    readonly scope: string | null;
    readonly intent: string | null;
    readonly decidedAgainst: string | null;
  }[];
  readonly initialHashes: readonly string[];
  readonly followUpAddedHashes: readonly string[];
  readonly finalHashes: readonly string[];
  readonly decisionsCount: number;
  readonly latenciesMs: {
    readonly total: number;
    readonly analyzePrompt?: number;
    readonly generateFollowUps?: number;
    readonly summarizeContext?: number;
  };
}

export interface RetrievalMetrics {
  readonly prompt_id: string;
  readonly mode: string;
  readonly model: string | null;
  readonly run: number;
  readonly precision_at_k: number;
  readonly recall_at_k: number;
  readonly ndcg_at_k: number;
  readonly must_include_hit: number;
  readonly latency_ms: number;
}

export interface ResponseBenchRecord {
  readonly timestamp: string;
  readonly prompt_id: string;
  readonly mode: "llm-enhanced" | "prompt-aware" | "recency";
  readonly model: string | null;
  readonly run: number;
  readonly run_id: string;
  readonly response: string;
  readonly duration_ms: number;
}

const decoder = new TextDecoder();

export const readJsonl = async <T>(path: string): Promise<readonly T[]> => {
  try {
    const text = await Deno.readTextFile(path);
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
};

export const writeJsonl = async <T>(
  path: string,
  rows: readonly T[],
): Promise<Result<void>> => {
  try {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
    await Deno.mkdir(dir, { recursive: true });
    const text = rows.map((row) => JSON.stringify(row)).join("\n");
    await Deno.writeTextFile(path, `${text}\n`);
    return Result.ok(undefined);
  } catch (e) {
    return Result.fail(e as Error);
  }
};

export const appendJsonl = async <T>(
  path: string,
  row: T,
): Promise<Result<void>> => {
  try {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
    await Deno.mkdir(dir, { recursive: true });
    const line = `${JSON.stringify(row)}\n`;
    await Deno.writeTextFile(path, line, { create: true, append: true });
    return Result.ok(undefined);
  } catch (e) {
    return Result.fail(e as Error);
  }
};

export const parseContextBlock = (
  stdout: string,
): { mode: string | null; block: string | null } => {
  const match = stdout.match(
    /<git-memory-context mode="([^"]+)">[\s\S]*?<\/git-memory-context>/,
  );
  if (!match) return { mode: null, block: null };
  return { mode: match[1], block: match[0] };
};

export const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((p / 100) * sorted.length)),
  );
  return sorted[index];
};

export const mean = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return sum / values.length;
};

export const dcgAtK = (
  hashes: readonly string[],
  relevanceByHash: ReadonlyMap<string, number>,
  k: number,
): number => {
  const slice = hashes.slice(0, k);
  return slice.reduce((acc, hash, i) => {
    const rel = Math.max(0, relevanceByHash.get(hash) ?? 0);
    const gain = (2 ** rel) - 1;
    const discount = Math.log2(i + 2);
    return acc + (gain / discount);
  }, 0);
};

export const ndcgAtK = (
  hashes: readonly string[],
  labels: readonly CommitLabel[],
  k: number,
): number => {
  const relevanceByHash = new Map(
    labels.map((l) => [l.hash, l.relevance] as const),
  );
  const actual = dcgAtK(hashes, relevanceByHash, k);
  const idealHashes = [...labels]
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, k)
    .map((l) => l.hash);
  const ideal = dcgAtK(idealHashes, relevanceByHash, k);
  if (ideal === 0) return 0;
  return actual / ideal;
};

export const readStdout = (bytes: Uint8Array): string =>
  decoder.decode(bytes).trim();
