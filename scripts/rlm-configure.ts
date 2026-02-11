/**
 * CLI to configure local LLM mode for recursive sub-calls.
 *
 * Usage:
 *   deno task rlm:configure                        # show current config
 *   deno task rlm:configure -- --enable             # enable LLM mode
 *   deno task rlm:configure -- --disable            # disable LLM mode
 *   deno task rlm:configure -- --model=llama3.2:3b  # change model
 *   deno task rlm:configure -- --check              # test Ollama connectivity
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

interface CliFlags {
  readonly enable: boolean;
  readonly disable: boolean;
  readonly check: boolean;
  readonly model: string | null;
  readonly endpoint: string | null;
  readonly timeout: number | null;
}

const parseFlags = (args: readonly string[]): CliFlags => {
  let enable = false;
  let disable = false;
  let check = false;
  let model: string | null = null;
  let endpoint: string | null = null;
  let timeout: number | null = null;

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

  return { enable, disable, check, model, endpoint, timeout };
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
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  const flags = parseFlags(Deno.args);
  const current = await loadRlmConfig();

  const hasModification = flags.enable || flags.disable ||
    flags.model !== null || flags.endpoint !== null || flags.timeout !== null;

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

  if (flags.enable) updated = { ...updated, enabled: true };
  if (flags.disable) updated = { ...updated, enabled: false };
  if (flags.model !== null) updated = { ...updated, model: flags.model };
  if (flags.endpoint !== null) {
    updated = { ...updated, endpoint: flags.endpoint };
  }
  if (flags.timeout !== null && !isNaN(flags.timeout)) {
    updated = { ...updated, timeoutMs: flags.timeout };
  }

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
