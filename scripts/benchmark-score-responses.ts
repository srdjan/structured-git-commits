/**
 * Scores Claude responses against gold facts.
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-net --allow-env scripts/benchmark-score-responses.ts \
 *     --dataset=bench/prompts.real.jsonl \
 *     --responses=bench/results/<run>/responses.jsonl \
 *     --out=bench/results/<run>/response-report.json \
 *     --judge-model=gemma2:3b
 *
 * If --judge-model is omitted, a lexical fallback scorer is used.
 */

import {
  mean,
  type PromptDatasetEntry,
  readJsonl,
  type ResponseBenchRecord,
} from "./lib/benchmark.ts";
import { callLocalLlm } from "./lib/local-llm.ts";

interface CliOptions {
  readonly datasetPath: string;
  readonly responsesPath: string;
  readonly outPath: string;
  readonly judgeModel: string | null;
  readonly endpoint: string;
}

interface ResponseScore {
  readonly prompt_id: string;
  readonly mode: string;
  readonly model: string | null;
  readonly run: number;
  readonly run_id: string;
  readonly fact_recall: number;
  readonly fact_precision: number;
  readonly helpfulness: number;
  readonly hallucination_count: number;
}

const parseCliArgs = (args: readonly string[]): CliOptions => {
  const get = (key: string): string | null => {
    const arg = args.find((a) => a.startsWith(`--${key}=`));
    return arg ? arg.slice(key.length + 3) : null;
  };

  const responsesPath = get("responses");
  if (!responsesPath) {
    console.error("Missing required flag: --responses=<responses.jsonl>");
    Deno.exit(2);
  }

  const datasetPath = get("dataset") ?? "bench/prompts.real.jsonl";
  const outPath = get("out") ??
    responsesPath.replace(/responses\.jsonl$/, "response-report.json");
  const judgeModel = get("judge-model");
  const endpoint = get("endpoint") ?? "http://localhost:11434";
  return { datasetPath, responsesPath, outPath, judgeModel, endpoint };
};

const clamp = (n: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, n));

const lexicalScore = (
  response: string,
  goldFacts: readonly string[],
): Omit<ResponseScore, "prompt_id" | "mode" | "model" | "run" | "run_id"> => {
  const normalized = response.toLowerCase();
  const hits =
    goldFacts.filter((fact) => normalized.includes(fact.toLowerCase())).length;
  const recall = goldFacts.length === 0 ? 0 : hits / goldFacts.length;
  const helpfulness = response.length < 40 ? 2 : response.length < 140 ? 3 : 4;

  return {
    fact_recall: recall,
    fact_precision: recall, // lexical fallback cannot robustly estimate precision
    helpfulness,
    hallucination_count: 0,
  };
};

const llmJudgeScore = async (
  endpoint: string,
  model: string,
  response: string,
  goldFacts: readonly string[],
): Promise<
  Omit<ResponseScore, "prompt_id" | "mode" | "model" | "run" | "run_id">
> => {
  const result = await callLocalLlm({
    endpoint,
    model,
    maxTokens: 256,
    timeoutMs: 10000,
    jsonMode: true,
    messages: [
      {
        role: "system",
        content:
          "Score an assistant answer against gold facts. Return JSON only with keys fact_recall (0..1), fact_precision (0..1), helpfulness (1..5), hallucination_count (integer >=0).",
      },
      {
        role: "user",
        content: `Gold facts:\n${
          goldFacts.map((f, i) => `${i + 1}. ${f}`).join("\n")
        }\n\nAnswer:\n${response}`,
      },
    ],
  });

  if (!result.ok) {
    return lexicalScore(response, goldFacts);
  }

  try {
    const parsed = JSON.parse(result.value) as Record<string, unknown>;
    return {
      fact_recall: clamp(Number(parsed.fact_recall ?? 0), 0, 1),
      fact_precision: clamp(Number(parsed.fact_precision ?? 0), 0, 1),
      helpfulness: clamp(Number(parsed.helpfulness ?? 3), 1, 5),
      hallucination_count: Math.max(
        0,
        Math.floor(Number(parsed.hallucination_count ?? 0)),
      ),
    };
  } catch {
    return lexicalScore(response, goldFacts);
  }
};

const main = async (): Promise<void> => {
  const options = parseCliArgs(Deno.args);
  const [dataset, responses] = await Promise.all([
    readJsonl<PromptDatasetEntry>(options.datasetPath),
    readJsonl<ResponseBenchRecord>(options.responsesPath),
  ]);

  if (dataset.length === 0 || responses.length === 0) {
    console.error("Dataset or responses are empty.");
    Deno.exit(1);
  }

  const labelsByPrompt = new Map(dataset.map((d) => [d.prompt_id, d] as const));
  const scores: ResponseScore[] = [];

  for (const row of responses) {
    const prompt = labelsByPrompt.get(row.prompt_id);
    if (!prompt) continue;

    const scored = options.judgeModel
      ? await llmJudgeScore(
        options.endpoint,
        options.judgeModel,
        row.response,
        prompt.gold_facts,
      )
      : lexicalScore(row.response, prompt.gold_facts);

    scores.push({
      prompt_id: row.prompt_id,
      mode: row.mode,
      model: row.model,
      run: row.run,
      run_id: row.run_id,
      ...scored,
    });
  }

  const grouped = new Map<string, ResponseScore[]>();
  for (const row of scores) {
    const key = `${row.mode}::${row.model ?? "baseline"}`;
    const existing = grouped.get(key) ?? [];
    existing.push(row);
    grouped.set(key, existing);
  }

  const summary = [...grouped.entries()].map(([key, rows]) => {
    const [mode, modelPart] = key.split("::");
    return {
      mode,
      model: modelPart === "baseline" ? null : modelPart,
      runs: rows.length,
      fact_recall_mean: mean(rows.map((r) => r.fact_recall)),
      fact_precision_mean: mean(rows.map((r) => r.fact_precision)),
      helpfulness_mean: mean(rows.map((r) => r.helpfulness)),
      hallucination_mean: mean(rows.map((r) => r.hallucination_count)),
    };
  });

  const report = {
    generated_at: new Date().toISOString(),
    judge_model: options.judgeModel,
    scorer: options.judgeModel
      ? "llm-judge-with-lexical-fallback"
      : "lexical-fallback",
    inputs: {
      dataset: options.datasetPath,
      responses: options.responsesPath,
    },
    per_mode_summary: summary,
    per_response_scores: scores,
  };

  const outDir = options.outPath.includes("/")
    ? options.outPath.slice(0, options.outPath.lastIndexOf("/"))
    : ".";
  await Deno.mkdir(outDir, { recursive: true });
  await Deno.writeTextFile(options.outPath, JSON.stringify(report, null, 2));

  console.log(`Response report written: ${options.outPath}`);
};

if (import.meta.main) {
  await main();
}
