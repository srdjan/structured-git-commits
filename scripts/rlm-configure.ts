/**
 * CLI to configure local LLM mode for recursive sub-calls.
 *
 * Usage:
 *   deno task rlm:configure                             # show current config
 *   deno task rlm:configure -- --enable                  # enable LLM mode
 *   deno task rlm:configure -- --disable                 # disable LLM mode
 *   deno task rlm:configure -- --model=llama3.2:3b       # change model
 *   deno task rlm:configure -- --check                   # test Ollama connectivity
 *   deno task rlm:configure -- --repl-enable              # enable REPL mode
 *   deno task rlm:configure -- --repl-disable             # disable REPL mode
 *   deno task rlm:configure -- --repl-max-iterations=3    # set REPL max iterations
 *   deno task rlm:configure -- --repl-max-llm-calls=5     # set REPL max LLM calls
 *   deno task rlm:configure -- --repl-timeout-budget=8000 # set REPL timeout (ms)
 *   deno task rlm:configure -- --repl-max-output-tokens=256
 */

import {
  DEFAULT_CONFIG,
  loadRlmConfig,
  type RlmConfig,
  saveRlmConfig,
} from "./lib/rlm-config.ts";
import { callLocalLlm } from "./lib/local-llm.ts";

// ---------------------------------------------------------------------------
// Argument Parsing
// ---------------------------------------------------------------------------

type CliFlags = {
  readonly enable: boolean;
  readonly disable: boolean;
  readonly check: boolean;
  readonly model: string | null;
  readonly endpoint: string | null;
  readonly timeout: number | null;
  readonly replEnable: boolean;
  readonly replDisable: boolean;
  readonly replMaxIterations: number | null;
  readonly replMaxLlmCalls: number | null;
  readonly replTimeoutBudget: number | null;
  readonly replMaxOutputTokens: number | null;
};

const parseIntFlag = (arg: string, prefix: string): number | null => {
  if (!arg.startsWith(prefix)) return null;
  const n = parseInt(arg.slice(prefix.length), 10);
  return isNaN(n) ? null : n;
};

const parseFlags = (args: readonly string[]): CliFlags => {
  let enable = false;
  let disable = false;
  let check = false;
  let model: string | null = null;
  let endpoint: string | null = null;
  let timeout: number | null = null;
  let replEnable = false;
  let replDisable = false;
  let replMaxIterations: number | null = null;
  let replMaxLlmCalls: number | null = null;
  let replTimeoutBudget: number | null = null;
  let replMaxOutputTokens: number | null = null;

  for (const arg of args) {
    if (arg === "--enable") enable = true;
    else if (arg === "--disable") disable = true;
    else if (arg === "--check") check = true;
    else if (arg.startsWith("--model=")) model = arg.slice("--model=".length);
    else if (arg.startsWith("--endpoint=")) {
      endpoint = arg.slice("--endpoint=".length);
    } else if (arg.startsWith("--timeout=")) {
      timeout = parseInt(arg.slice("--timeout=".length), 10);
    }
  }

  return {
    enable, disable, check, model, endpoint, timeout,
    replEnable, replDisable, replMaxIterations, replMaxLlmCalls,
    replTimeoutBudget, replMaxOutputTokens,
  };
};

// ---------------------------------------------------------------------------
// Check Connectivity
// ---------------------------------------------------------------------------

const checkConnectivity = async (config: RlmConfig): Promise<void> => {
  console.log(`Checking ${config.endpoint} with model ${config.model}...`);

  const result = await callLocalLlm({
    endpoint: config.endpoint,
    model: config.model,
    messages: [{ role: "user", content: "Reply with exactly: ok" }],
    maxTokens: Math.max(256, config.maxTokens),
    timeoutMs: config.timeoutMs,
  });

  if (result.ok) {
    console.log(`Connected. Response: "${result.value}"`);
  } else {
    console.error(`Failed: ${result.error.message}`);
    console.error("");
    console.error("Make sure Ollama is running:");
    console.error("  ollama serve");
    console.error(`  ollama pull ${config.model}`);
    Deno.exit(1);
  }
};

// ---------------------------------------------------------------------------
// Show Config
// ---------------------------------------------------------------------------

const showConfig = (config: RlmConfig): void => {
  console.log("Current RLM config:");
  console.log(`  enabled:   ${config.enabled}`);
  console.log(`  endpoint:  ${config.endpoint}`);
  console.log(`  model:     ${config.model}`);
  console.log(`  timeoutMs: ${config.timeoutMs}`);
  console.log(`  maxTokens: ${config.maxTokens}`);
  console.log("");
  console.log("REPL settings:");
  console.log(`  replEnabled:          ${config.replEnabled}`);
  console.log(`  replMaxIterations:    ${config.replMaxIterations}`);
  console.log(`  replMaxLlmCalls:      ${config.replMaxLlmCalls}`);
  console.log(`  replTimeoutBudgetMs:  ${config.replTimeoutBudgetMs}`);
  console.log(`  replMaxOutputTokens:  ${config.replMaxOutputTokens}`);
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  const flags = parseFlags(Deno.args);
  const current = await loadRlmConfig();

  const hasModification = flags.enable || flags.disable ||
    flags.model !== null || flags.endpoint !== null || flags.timeout !== null ||
    flags.replEnable || flags.replDisable ||
    flags.replMaxIterations !== null || flags.replMaxLlmCalls !== null ||
    flags.replTimeoutBudget !== null || flags.replMaxOutputTokens !== null;

  if (!hasModification && !flags.check) {
    showConfig(current);
    return;
  }

  // Apply modifications
  let updated: RlmConfig = { ...current };

  if (flags.enable && flags.disable) {
    console.error("Cannot use --enable and --disable together.");
    Deno.exit(1);
  }
  if (flags.replEnable && flags.replDisable) {
    console.error("Cannot use --repl-enable and --repl-disable together.");
    Deno.exit(1);
  }

  if (flags.enable) updated = { ...updated, enabled: true };
  if (flags.disable) updated = { ...updated, enabled: false };
  if (flags.model !== null) updated = { ...updated, model: flags.model };
  if (flags.endpoint !== null) {
    updated = { ...updated, endpoint: flags.endpoint };
  }
  if (flags.timeout !== null && !isNaN(flags.timeout)) {
    updated = { ...updated, timeoutMs: flags.timeout };
  }

  if (flags.replEnable) updated = { ...updated, replEnabled: true };
  if (flags.replDisable) updated = { ...updated, replEnabled: false };
  if (flags.replMaxIterations !== null) updated = { ...updated, replMaxIterations: flags.replMaxIterations };
  if (flags.replMaxLlmCalls !== null) updated = { ...updated, replMaxLlmCalls: flags.replMaxLlmCalls };
  if (flags.replTimeoutBudget !== null) updated = { ...updated, replTimeoutBudgetMs: flags.replTimeoutBudget };
  if (flags.replMaxOutputTokens !== null) updated = { ...updated, replMaxOutputTokens: flags.replMaxOutputTokens };

  if (hasModification) {
    const saveResult = await saveRlmConfig(updated);
    if (!saveResult.ok) {
      console.error(`Failed to save config: ${saveResult.error.message}`);
      Deno.exit(1);
    }
    showConfig(updated);
  }

  if (flags.check) {
    console.log("");
    await checkConnectivity(updated);
  }
};

if (import.meta.main) {
  main();
}
