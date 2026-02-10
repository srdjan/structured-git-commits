/**
 * Scores retrieval quality and latency from benchmark outputs.
 *
 * Inputs:
 *   --dataset=bench/prompts.real.jsonl
 *   --runs=bench/results/<run>/runs.jsonl
 *   --trace=bench/results/<run>/trace.jsonl
 *   --k=10
 *
 * Output:
 *   --out=bench/results/<run>/retrieval-report.json
 */

import {
  type ContextBenchRun,
  type ContextBenchTrace,
  mean,
  ndcgAtK,
  percentile,
  type PromptDatasetEntry,
  readJsonl,
  type RetrievalMetrics,
} from "./lib/benchmark.ts";

interface CliOptions {
  readonly datasetPath: string;
  readonly runsPath: string;
  readonly tracePath: string;
  readonly outPath: string;
  readonly k: number;
}

interface QueryPrecisionMetrics {
  readonly mode: string;
  readonly model: string | null;
  readonly runs: number;
  readonly follow_up_query_rate: number;
  readonly follow_up_novel_relevant_rate: number;
  readonly follow_up_marginal_recall_gain: number;
}

const parseCliArgs = (args: readonly string[]): CliOptions => {
  const get = (key: string): string | null => {
    const arg = args.find((a) => a.startsWith(`--${key}=`));
    return arg ? arg.slice(key.length + 3) : null;
  };

  const datasetPath = get("dataset") ?? "bench/prompts.real.jsonl";
  const runsPath = get("runs");
  const tracePath = get("trace");
  if (!runsPath || !tracePath) {
    console.error(
      "Usage: --runs=<runs.jsonl> --trace=<trace.jsonl> [--dataset=...] [--k=10]",
    );
    Deno.exit(2);
  }

  const outPath = get("out") ??
    runsPath.replace(/runs\.jsonl$/, "retrieval-report.json");
  const kRaw = get("k") ?? "10";
  const k = Number.parseInt(kRaw, 10);
  if (Number.isNaN(k) || k <= 0) {
    console.error(`Invalid --k value: "${kRaw}"`);
    Deno.exit(2);
  }

  return { datasetPath, runsPath, tracePath, outPath, k };
};

const keyOf = (mode: string, model: string | null): string =>
  `${mode}::${model ?? "baseline"}`;
const pairKey = (promptId: string, run: number): string =>
  `${promptId}::${run}`;

const precisionAtK = (
  hashes: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number => {
  const slice = hashes.slice(0, k);
  if (slice.length === 0) return 0;
  const hits = slice.filter((h) => relevant.has(h)).length;
  return hits / slice.length;
};

const recallAtK = (
  hashes: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number => {
  if (relevant.size === 0) return 0;
  const slice = hashes.slice(0, k);
  const hits = slice.filter((h) => relevant.has(h)).length;
  return hits / relevant.size;
};

const meanDelta = (
  target: ReadonlyMap<string, number>,
  base: ReadonlyMap<string, number>,
): number => {
  const deltas: number[] = [];
  for (const [key, value] of target.entries()) {
    const baseline = base.get(key);
    if (baseline === undefined) continue;
    deltas.push(value - baseline);
  }
  return mean(deltas);
};

const main = async (): Promise<void> => {
  const options = parseCliArgs(Deno.args);

  const [dataset, runs, traces] = await Promise.all([
    readJsonl<PromptDatasetEntry>(options.datasetPath),
    readJsonl<ContextBenchRun>(options.runsPath),
    readJsonl<ContextBenchTrace>(options.tracePath),
  ]);

  if (dataset.length === 0 || runs.length === 0 || traces.length === 0) {
    console.error("Dataset, runs, or traces are empty.");
    Deno.exit(1);
  }

  const datasetById = new Map(dataset.map((d) => [d.prompt_id, d] as const));
  const traceByRunId = new Map(
    traces
      .filter((t) => t.runId !== null)
      .map((t) => [t.runId as string, t] as const),
  );

  const metrics: RetrievalMetrics[] = [];
  const perKeyMetrics = new Map<string, RetrievalMetrics[]>();
  const perKeyRecall = new Map<string, Map<string, number>>();
  const perKeyPrecision = new Map<string, Map<string, number>>();
  const perKeyNdcg = new Map<string, Map<string, number>>();
  const queryPrecisionRows: QueryPrecisionMetrics[] = [];

  for (const run of runs) {
    const trace = traceByRunId.get(run.run_id);
    const promptData = datasetById.get(run.prompt_id);
    if (!trace || !promptData) continue;

    const relevantLabels = promptData.commit_labels.filter((c) =>
      c.relevance > 0
    );
    const relevantSet = new Set(relevantLabels.map((c) => c.hash));
    const hashes = trace.finalHashes;

    const row: RetrievalMetrics = {
      prompt_id: run.prompt_id,
      mode: run.mode,
      model: run.model,
      run: run.run,
      precision_at_k: precisionAtK(hashes, relevantSet, options.k),
      recall_at_k: recallAtK(hashes, relevantSet, options.k),
      ndcg_at_k: ndcgAtK(hashes, promptData.commit_labels, options.k),
      must_include_hit: promptData.must_include_hashes.every((h) =>
          hashes.includes(h)
        )
        ? 1
        : 0,
      latency_ms: trace.latenciesMs.total,
    };
    metrics.push(row);

    const k = keyOf(row.mode, row.model);
    const rows = perKeyMetrics.get(k) ?? [];
    rows.push(row);
    perKeyMetrics.set(k, rows);

    const pair = pairKey(row.prompt_id, row.run);

    const addPair = (map: Map<string, Map<string, number>>, value: number) => {
      const inner = map.get(k) ?? new Map<string, number>();
      inner.set(pair, value);
      map.set(k, inner);
    };

    addPair(perKeyRecall, row.recall_at_k);
    addPair(perKeyPrecision, row.precision_at_k);
    addPair(perKeyNdcg, row.ndcg_at_k);
  }

  // Query precision metrics for llm-enhanced runs.
  for (const [key, rows] of perKeyMetrics.entries()) {
    const [mode, modelPart] = key.split("::");
    if (mode !== "llm-enhanced") continue;

    const traceRows = rows
      .map((r) =>
        traceByRunId.get(
          runs.find((run) =>
            run.prompt_id === r.prompt_id &&
            run.mode === r.mode &&
            run.model === r.model &&
            run.run === r.run
          )?.run_id ?? "",
        )
      )
      .filter((t): t is ContextBenchTrace => Boolean(t));

    const followUpQueryRate = mean(
      traceRows.map((
        t,
      ) => (t.followUpQueries && t.followUpQueries.length > 0 ? 1 : 0)),
    );

    const novelRelevantRates: number[] = [];
    const marginalRecallGains: number[] = [];

    for (const t of traceRows) {
      const prompt = datasetById.get(t.promptId ?? "");
      if (!prompt) continue;
      const relevant = new Set(
        prompt.commit_labels.filter((c) => c.relevance > 0).map((c) => c.hash),
      );

      const added = t.followUpAddedHashes;
      const addedHits = added.filter((h) => relevant.has(h)).length;
      novelRelevantRates.push(
        added.length === 0 ? 0 : addedHits / added.length,
      );

      const initialHits = t.initialHashes.filter((h) => relevant.has(h)).length;
      const finalHits = t.finalHashes.filter((h) => relevant.has(h)).length;
      const denom = Math.max(1, relevant.size);
      marginalRecallGains.push((finalHits / denom) - (initialHits / denom));
    }

    queryPrecisionRows.push({
      mode,
      model: modelPart === "baseline" ? null : modelPart,
      runs: traceRows.length,
      follow_up_query_rate: followUpQueryRate,
      follow_up_novel_relevant_rate: mean(novelRelevantRates),
      follow_up_marginal_recall_gain: mean(marginalRecallGains),
    });
  }

  const perModeSummary = [...perKeyMetrics.entries()].map(([key, rows]) => {
    const [mode, modelPart] = key.split("::");
    const latencies = rows.map((r) => r.latency_ms);

    return {
      mode,
      model: modelPart === "baseline" ? null : modelPart,
      runs: rows.length,
      precision_at_k_mean: mean(rows.map((r) => r.precision_at_k)),
      recall_at_k_mean: mean(rows.map((r) => r.recall_at_k)),
      ndcg_at_k_mean: mean(rows.map((r) => r.ndcg_at_k)),
      must_include_hit_rate: mean(rows.map((r) => r.must_include_hit)),
      latency_ms_p50: percentile(latencies, 50),
      latency_ms_p90: percentile(latencies, 90),
    };
  });

  const promptAwareKey = keyOf("prompt-aware", null);
  const recencyKey = keyOf("recency", null);
  const pairedDeltas = perModeSummary
    .filter((row) => row.mode === "llm-enhanced")
    .map((row) => {
      const key = keyOf(row.mode, row.model);
      const recalls = perKeyRecall.get(key) ?? new Map<string, number>();
      const precisions = perKeyPrecision.get(key) ?? new Map<string, number>();
      const ndcgs = perKeyNdcg.get(key) ?? new Map<string, number>();

      return {
        mode: row.mode,
        model: row.model,
        delta_vs_prompt_aware: {
          recall_at_k: meanDelta(
            recalls,
            perKeyRecall.get(promptAwareKey) ?? new Map(),
          ),
          precision_at_k: meanDelta(
            precisions,
            perKeyPrecision.get(promptAwareKey) ?? new Map(),
          ),
          ndcg_at_k: meanDelta(
            ndcgs,
            perKeyNdcg.get(promptAwareKey) ?? new Map(),
          ),
        },
        delta_vs_recency: {
          recall_at_k: meanDelta(
            recalls,
            perKeyRecall.get(recencyKey) ?? new Map(),
          ),
          precision_at_k: meanDelta(
            precisions,
            perKeyPrecision.get(recencyKey) ?? new Map(),
          ),
          ndcg_at_k: meanDelta(ndcgs, perKeyNdcg.get(recencyKey) ?? new Map()),
        },
      };
    });

  const report = {
    generated_at: new Date().toISOString(),
    k: options.k,
    inputs: {
      dataset: options.datasetPath,
      runs: options.runsPath,
      trace: options.tracePath,
    },
    per_mode_summary: perModeSummary,
    query_precision: queryPrecisionRows,
    paired_deltas: pairedDeltas,
    per_run_metrics: metrics,
  };

  const outDir = options.outPath.includes("/")
    ? options.outPath.slice(0, options.outPath.lastIndexOf("/"))
    : ".";
  await Deno.mkdir(outDir, { recursive: true });
  await Deno.writeTextFile(options.outPath, JSON.stringify(report, null, 2));

  console.log(`Retrieval report written: ${options.outPath}`);
};

if (import.meta.main) {
  await main();
}
