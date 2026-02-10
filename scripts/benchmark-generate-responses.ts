/**
 * Generates Claude responses using captured git-memory contexts from benchmark runs.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... deno run --allow-read --allow-write --allow-env --allow-net \
 *     scripts/benchmark-generate-responses.ts \
 *     --runs=bench/results/<run>/runs.jsonl \
 *     --out=bench/results/<run>/responses.jsonl \
 *     --model=claude-sonnet-4-5-20250929 \
 *     --selection=first
 */

import { callClaude } from "./lib/llm.ts";
import {
  appendJsonl,
  type ContextBenchRun,
  type PromptDatasetEntry,
  readJsonl,
  type ResponseBenchRecord,
} from "./lib/benchmark.ts";

interface CliOptions {
  readonly datasetPath: string;
  readonly runsPath: string;
  readonly outPath: string;
  readonly model: string | null;
  readonly selection: "first" | "all";
  readonly limit: number | null;
}

const parseCliArgs = (args: readonly string[]): CliOptions => {
  const get = (key: string): string | null => {
    const arg = args.find((a) => a.startsWith(`--${key}=`));
    return arg ? arg.slice(key.length + 3) : null;
  };

  const runsPath = get("runs");
  if (!runsPath) {
    console.error("Missing required flag: --runs=<runs.jsonl>");
    Deno.exit(2);
  }

  const outPath = get("out") ??
    runsPath.replace(/runs\.jsonl$/, "responses.jsonl");
  const datasetPath = get("dataset") ?? "bench/prompts.real.jsonl";
  const model = get("model");
  const selectionRaw = get("selection") ?? "first";
  const selection = selectionRaw === "all" ? "all" : "first";
  const limitRaw = get("limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : null;
  if (limitRaw && (Number.isNaN(limit) || (limit ?? 0) <= 0)) {
    console.error(`Invalid --limit value: "${limitRaw}"`);
    Deno.exit(2);
  }

  return { datasetPath, runsPath, outPath, model, selection, limit };
};

const dedupeFirst = (
  rows: readonly ContextBenchRun[],
): readonly ContextBenchRun[] => {
  const seen = new Set<string>();
  const out: ContextBenchRun[] = [];
  for (const row of rows) {
    const key = `${row.prompt_id}::${row.mode}::${row.model ?? "baseline"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
};

const buildUserMessage = (
  prompt: string,
  contextBlock: string | null,
): string => {
  const context = contextBlock ??
    '<git-memory-context mode="missing">(none)</git-memory-context>';
  return `${context}

User prompt:
${prompt}

Instructions:
- Answer the user prompt directly.
- Use facts from the git-memory context when relevant.
- If context is insufficient for a claim, say what is missing.`;
};

const main = async (): Promise<void> => {
  const options = parseCliArgs(Deno.args);
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is required.");
    Deno.exit(1);
  }

  const [runs, dataset] = await Promise.all([
    readJsonl<ContextBenchRun>(options.runsPath),
    readJsonl<PromptDatasetEntry>(options.datasetPath),
  ]);
  if (runs.length === 0 || dataset.length === 0) {
    console.error("Runs or dataset are empty.");
    Deno.exit(1);
  }

  const promptById = new Map(
    dataset.map((d) => [d.prompt_id, d.prompt] as const),
  );
  const eligible = runs.filter((r) =>
    r.exit_code === 0 && r.context_block !== null
  );
  const selected = options.selection === "first"
    ? dedupeFirst(eligible)
    : eligible;
  const limited = options.limit ? selected.slice(0, options.limit) : selected;

  await Deno.remove(options.outPath).catch(() => {});

  for (const row of limited) {
    const prompt = promptById.get(row.prompt_id);
    if (!prompt) continue;

    const started = performance.now();
    const response = await callClaude({
      apiKey,
      model: options.model ?? undefined,
      system:
        "You are a software engineering assistant. Provide concise, accurate answers grounded in supplied context.",
      user: buildUserMessage(prompt, row.context_block),
    });
    const durationMs = performance.now() - started;

    if (!response.ok) {
      console.error(
        `Failed response for ${row.run_id}: ${response.error.message}`,
      );
      continue;
    }

    const out: ResponseBenchRecord = {
      timestamp: new Date().toISOString(),
      prompt_id: row.prompt_id,
      mode: row.mode,
      model: row.model,
      run: row.run,
      run_id: row.run_id,
      response: response.value,
      duration_ms: durationMs,
    };
    await appendJsonl(options.outPath, out);
  }

  console.log(`Responses written: ${options.outPath}`);
};

if (import.meta.main) {
  await main();
}
