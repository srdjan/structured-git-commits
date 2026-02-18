/**
 * Structured Commit Validator - CLI
 *
 * Validates a commit message against the structured git commits specification.
 * Can be used as a git commit-msg hook or standalone validator.
 *
 * Usage as git hook:
 *   Copy to .git/hooks/commit-msg and make executable, or:
 *   deno run --allow-read scripts/validate-commit.ts "$1"
 *
 * Usage standalone:
 *   echo "feat(auth): add login" | deno run scripts/validate-commit.ts --stdin
 *   deno run --allow-read scripts/validate-commit.ts path/to/commit-msg-file
 */

import type { Diagnostic } from "./types.ts";
import { validate } from "./lib/validator.ts";

// ---------------------------------------------------------------------------
// Input Reading
// ---------------------------------------------------------------------------

const readStdin = async (): Promise<string> => {
  const chunks: Uint8Array[] = [];
  const reader = Deno.stdin.readable.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder().decode(combined);
};

const readInput = async (): Promise<string> => {
  const args = Deno.args;

  if (args.includes("--stdin")) {
    return await readStdin();
  }

  const filePath = args.find((a) => !a.startsWith("--"));
  if (filePath) {
    return await Deno.readTextFile(filePath);
  }

  console.error("Usage: validate-commit.ts <file> or --stdin");
  Deno.exit(2);
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const formatDiagnostic = (d: Diagnostic): string => {
  const icon = d.severity === "error" ? "x" : "!";
  return `  ${icon} [${d.rule}] ${d.message}`;
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  const message = await readInput();
  const diagnostics = validate(message);

  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity === "warning");

  if (diagnostics.length === 0) {
    console.log("Commit message is valid");
    Deno.exit(0);
  }

  if (errors.length > 0) {
    console.error("Commit message validation failed:\n");
    errors.forEach((d) => console.error(formatDiagnostic(d)));
  }

  if (warnings.length > 0) {
    console.warn("\nWarnings:\n");
    warnings.forEach((d) => console.warn(formatDiagnostic(d)));
  }

  Deno.exit(errors.length > 0 ? 1 : 0);
};

main();
