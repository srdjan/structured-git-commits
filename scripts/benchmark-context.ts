/**
 * Benchmark runner for git-memory context extraction modes.
 *
 * Runs the same prompt dataset against:
 *   - llm-enhanced (for each configured local model)
 *   - prompt-aware
 *   - recency (forced by temporarily removing trailer index)
 *
 * Outputs:
 *   - runs.jsonl: one record per prompt execution
 *   - trace.jsonl: detailed retrieval traces emitted by git-memory-context.ts
 *   - summary.json: run metadata and counts
 *
 * Usage:
 *   deno run --allow-run --allow-read --allow-write --allow-env --allow-net scripts/benchmark-context.ts \
 *     --dataset=bench/prompts.real.jsonl \
 *     --out-dir=bench/results/run-001 \
 *     --runs=3 \
 *     --models=gemma2:3b,qwen2.5:7b
 */

import { Result } from "./types.ts";
import {
  appendJsonl,
  type ContextBenchRun,
  parseContextBlock,
  type PromptDatasetEntry,
  readJsonl,
  readStdout,
} from "./lib/benchmark.ts";
import { callLocalLlm } from "./lib/local-llm.ts";
import {
  getConfigPath,
  loadRlmConfig,
  type RlmConfig,
  saveRlmConfig,
} from "./lib/rlm-config.ts";

interface CliOptions {
  readonly datasetPath: string;
  readonly outDir: string;
  readonly runs: number;
  readonly models: readonly string[];
  readonly checkModels: boolean;
}

const parseCliArgs = (args: readonly string[]): CliOptions => {
  const get = (key: string): string | null => {
    const arg = args.find((a) => a.startsWith(`--${key}=`));
    return arg ? arg.slice(key.length + 3) : null;
  };
  const has = (key: string): boolean => args.includes(`--${key}`);

  const datasetPath = get("dataset") ?? "bench/prompts.real.jsonl";
  const outDir = get("out-dir") ??
    `bench/results/${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const runsRaw = get("runs") ?? "3";
  const runs = Number.parseInt(runsRaw, 10);
  if (Number.isNaN(runs) || runs <= 0) {
    console.error(`Invalid --runs value: "${runsRaw}"`);
    Deno.exit(2);
  }

  const modelsRaw = get("models");
  const models = modelsRaw
    ? modelsRaw.split(",").map((m) => m.trim()).filter((m) => m.length > 0)
    : [];

  return {
    datasetPath,
    outDir,
    runs,
    models,
    checkModels: !has("skip-model-check"),
  };
};

const runCommand = async (
  command: string,
  args: readonly string[],
  stdinText: string | null = null,
  env: Readonly<Record<string, string>> = {},
): Promise<Result<{ code: number; stdout: string; stderr: string }>> => {
  try {
    const child = new Deno.Command(command, {
      args: args as string[],
      stdin: stdinText === null ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
      env,
    }).spawn();

    if (stdinText !== null && child.stdin) {
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(stdinText));
      await writer.close();
    }

    const output = await child.output();
    return Result.ok({
      code: output.code,
      stdout: readStdout(output.stdout),
      stderr: readStdout(output.stderr),
    });
  } catch (e) {
    return Result.fail(e as Error);
  }
};

const getGitDir = async (): Promise<Result<string>> => {
  const result = await runCommand("git", ["rev-parse", "--git-dir"]);
  if (!result.ok) return result as Result<never>;
  if (result.value.code !== 0) {
    return Result.fail(
      new Error(result.value.stderr || "Not a git repository"),
    );
  }
  return Result.ok(result.value.stdout.trim());
};

const ensureFreshIndex = async (): Promise<Result<void>> => {
  const result = await runCommand("deno", [
    "run",
    "--allow-run",
    "--allow-read",
    "--allow-write",
    "scripts/build-trailer-index.ts",
  ]);
  if (!result.ok) return result as Result<never>;
  if (result.value.code !== 0) {
    return Result.fail(
      new Error(
        result.value.stderr || result.value.stdout || "index build failed",
      ),
    );
  }
  return Result.ok(undefined);
};

const withIndexTemporarilyHidden = async <T>(
  indexPath: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const backupPath = `${indexPath}.benchmark-backup`;
  let moved = false;
  try {
    await Deno.stat(indexPath);
    await Deno.rename(indexPath, backupPath);
    moved = true;
  } catch {
    // missing index is fine for recency mode
  }

  try {
    return await fn();
  } finally {
    if (moved) {
      try {
        await Deno.rename(backupPath, indexPath);
      } catch {
        // ignore restore errors here; outer cleanup handles final restoration
      }
    }
  }
};

const restoreFile = async (
  path: string,
  originalContent: string | null,
): Promise<void> => {
  if (originalContent === null) {
    try {
      await Deno.remove(path);
    } catch {
      // ignore
    }
    return;
  }
  await Deno.writeTextFile(path, originalContent);
};

const loadDataset = async (
  path: string,
): Promise<readonly PromptDatasetEntry[]> => {
  const rows = await readJsonl<PromptDatasetEntry>(path);
  if (rows.length === 0) {
    console.error(`No prompts found in ${path}`);
    Deno.exit(2);
  }
  return rows;
};

const configureRlm = async (
  base: RlmConfig,
  enabled: boolean,
  model: string | null,
): Promise<Result<void>> => {
  const updated: RlmConfig = {
    ...base,
    enabled,
    model: model ?? base.model,
  };
  return await saveRlmConfig(updated);
};

const checkModelConnectivity = async (
  config: RlmConfig,
  model: string,
): Promise<Result<void>> => {
  const result = await callLocalLlm({
    endpoint: config.endpoint,
    model,
    messages: [{ role: "user", content: "Reply with exactly: ok" }],
    maxTokens: Math.max(256, config.maxTokens),
    timeoutMs: config.timeoutMs,
  });
  if (!result.ok) {
    return Result.fail(
      new Error(`Model check failed for ${model}: ${result.error.message}`),
    );
  }
  return Result.ok(undefined);
};

const runContextOnce = async (
  prompt: string,
  promptId: string,
  mode: "llm-enhanced" | "prompt-aware" | "recency",
  model: string | null,
  run: number,
  tracePath: string,
): Promise<Result<ContextBenchRun>> => {
  const runId = `${mode}:${
    model ?? "baseline"
  }:${promptId}:run-${run}:${crypto.randomUUID()}`;
  const env = {
    RLM_BENCH_TRACE: "1",
    RLM_BENCH_TRACE_FILE: tracePath,
    RLM_BENCH_PROMPT_ID: promptId,
    RLM_BENCH_RUN_ID: runId,
    STRUCTURED_GIT_SESSION: "",
  };

  const started = performance.now();
  const result = await runCommand(
    "deno",
    [
      "run",
      "--allow-run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-net",
      "scripts/git-memory-context.ts",
    ],
    JSON.stringify({ prompt }),
    env,
  );
  const durationMs = performance.now() - started;

  if (!result.ok) return result as Result<never>;
  const parsed = parseContextBlock(result.value.stdout);

  return Result.ok({
    timestamp: new Date().toISOString(),
    prompt_id: promptId,
    prompt,
    mode,
    model,
    run,
    run_id: runId,
    duration_ms: durationMs,
    exit_code: result.value.code,
    context_mode: parsed.mode,
    context_block: parsed.block,
    stderr: result.value.stderr,
  });
};

const main = async (): Promise<void> => {
  const options = parseCliArgs(Deno.args);
  const prompts = await loadDataset(options.datasetPath);

  const gitDirResult = await getGitDir();
  if (!gitDirResult.ok) {
    console.error(`Failed to resolve git dir: ${gitDirResult.error.message}`);
    Deno.exit(1);
  }

  const gitDir = gitDirResult.value;
  const indexPath = `${gitDir}/info/trailer-index.json`;
  const tracePath = `${options.outDir}/trace.jsonl`;
  const runsPath = `${options.outDir}/runs.jsonl`;
  const summaryPath = `${options.outDir}/summary.json`;

  const configPathResult = await getConfigPath();
  if (!configPathResult.ok) {
    console.error(
      `Failed to resolve RLM config path: ${configPathResult.error.message}`,
    );
    Deno.exit(1);
  }
  const configPath = configPathResult.value;

  const originalConfig = await Deno.readTextFile(configPath).catch(() => null);
  const originalIndex = await Deno.readTextFile(indexPath).catch(() => null);

  const baseConfig = await loadRlmConfig();
  const models = options.models.length > 0
    ? options.models
    : [baseConfig.model];

  await Deno.mkdir(options.outDir, { recursive: true });
  await Deno.remove(tracePath).catch(() => {});
  await Deno.remove(runsPath).catch(() => {});

  const phaseSummary: {
    readonly phase: string;
    readonly total: number;
    readonly failures: number;
  }[] = [];

  try {
    if (options.checkModels) {
      for (const model of models) {
        const check = await checkModelConnectivity(baseConfig, model);
        if (!check.ok) {
          console.error(check.error.message);
          Deno.exit(1);
        }
      }
    }

    // Prompt-aware baseline
    {
      const cfg = await configureRlm(baseConfig, false, null);
      if (!cfg.ok) {
        console.error(
          `Failed to set prompt-aware config: ${cfg.error.message}`,
        );
        Deno.exit(1);
      }
      const idx = await ensureFreshIndex();
      if (!idx.ok) {
        console.error(`Failed to build trailer index: ${idx.error.message}`);
        Deno.exit(1);
      }

      let total = 0;
      let failures = 0;
      for (let run = 1; run <= options.runs; run++) {
        for (const prompt of prompts) {
          const record = await runContextOnce(
            prompt.prompt,
            prompt.prompt_id,
            "prompt-aware",
            null,
            run,
            tracePath,
          );
          if (!record.ok) {
            failures += 1;
            continue;
          }
          total += 1;
          if (record.value.exit_code !== 0) failures += 1;
          await appendJsonl(runsPath, record.value);
        }
      }
      phaseSummary.push({ phase: "prompt-aware", total, failures });
    }

    // Recency baseline (forced by hiding index)
    {
      const cfg = await configureRlm(baseConfig, false, null);
      if (!cfg.ok) {
        console.error(`Failed to set recency config: ${cfg.error.message}`);
        Deno.exit(1);
      }

      let total = 0;
      let failures = 0;
      await withIndexTemporarilyHidden(indexPath, async () => {
        for (let run = 1; run <= options.runs; run++) {
          for (const prompt of prompts) {
            const record = await runContextOnce(
              prompt.prompt,
              prompt.prompt_id,
              "recency",
              null,
              run,
              tracePath,
            );
            if (!record.ok) {
              failures += 1;
              continue;
            }
            total += 1;
            if (record.value.exit_code !== 0) failures += 1;
            await appendJsonl(runsPath, record.value);
          }
        }
      });
      phaseSummary.push({ phase: "recency", total, failures });
    }

    // LLM-enhanced (per model)
    for (const model of models) {
      const cfg = await configureRlm(baseConfig, true, model);
      if (!cfg.ok) {
        console.error(
          `Failed to set llm config (${model}): ${cfg.error.message}`,
        );
        Deno.exit(1);
      }
      const idx = await ensureFreshIndex();
      if (!idx.ok) {
        console.error(`Failed to build trailer index: ${idx.error.message}`);
        Deno.exit(1);
      }

      let total = 0;
      let failures = 0;
      for (let run = 1; run <= options.runs; run++) {
        for (const prompt of prompts) {
          const record = await runContextOnce(
            prompt.prompt,
            prompt.prompt_id,
            "llm-enhanced",
            model,
            run,
            tracePath,
          );
          if (!record.ok) {
            failures += 1;
            continue;
          }
          total += 1;
          if (record.value.exit_code !== 0) failures += 1;
          await appendJsonl(runsPath, record.value);
        }
      }
      phaseSummary.push({ phase: `llm-enhanced:${model}`, total, failures });
    }
  } finally {
    await restoreFile(configPath, originalConfig);
    await restoreFile(indexPath, originalIndex);
  }

  const summary = {
    generated_at: new Date().toISOString(),
    dataset_path: options.datasetPath,
    out_dir: options.outDir,
    runs_per_prompt: options.runs,
    models,
    phases: phaseSummary,
  };
  await Deno.writeTextFile(summaryPath, JSON.stringify(summary, null, 2));

  console.log(`Benchmark run complete.`);
  console.log(`  runs:    ${runsPath}`);
  console.log(`  trace:   ${tracePath}`);
  console.log(`  summary: ${summaryPath}`);
};

if (import.meta.main) {
  await main();
}
