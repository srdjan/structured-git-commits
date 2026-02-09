/**
 * Pure functions for constructing LLM prompts used in commit retrofitting.
 *
 * Assembles system and user prompts from the format spec, intent taxonomy,
 * and minimal commit extracts. All functions are side-effect free.
 */

import type { CommitExtract, Diagnostic } from "../types.ts";

export const buildSystemPrompt = (
  formatSpec: string,
  taxonomy: string,
): string =>
  `You are a commit message formatter. Your job is to rewrite git commit messages into the structured format defined below.

OUTPUT RULES:
- Output ONLY the structured commit message, nothing else
- No markdown fences, no explanations, no preamble
- Follow the format specification exactly

FORMAT SPECIFICATION:
${formatSpec}

INTENT TAXONOMY:
${taxonomy}

EXAMPLES:

Example 1 - Feature commit:

feat(auth): add passkey registration for agent identities

Implement WebAuthn registration flow supporting non-human identity types.
Hardware-bound credentials provide stronger guarantees than shared secrets
for autonomous agent authentication.

Intent: enable-capability
Scope: auth/registration, identity/agent
Decided-Against: OAuth2 client credentials (no hardware binding guarantee)

Example 2 - Bug fix:

fix(orders): correct timezone offset in schedule calculations

Schedule windows were computed in UTC but displayed in local time without
conversion, causing orders to appear in the wrong delivery slot.

Intent: fix-defect
Scope: orders/scheduling

Example 3 - Infrastructure:

chore: update Deno to 2.1 and adjust deprecated API calls

Intent: configure-infra
Scope: infra/runtime`;

export const buildUserPrompt = (extract: CommitExtract): string =>
  `Rewrite this commit as a structured commit message.

Hash: ${extract.hash}
Date: ${extract.date}
Author: ${extract.author}

Original message:
${extract.message}

Files changed (diff --stat):
${extract.stat || "(no stat available)"}

Summary: ${extract.shortstat || "(no shortstat available)"}`;

export const buildRetryPrompt = (
  extract: CommitExtract,
  errors: readonly Diagnostic[],
): string => {
  const errorList = errors
    .map((d) => `- [${d.severity}] ${d.rule}: ${d.message}`)
    .join("\n");

  return `Your previous attempt had validation errors. Fix them and output only the corrected commit message.

VALIDATION ERRORS:
${errorList}

ORIGINAL COMMIT:
Hash: ${extract.hash}
Date: ${extract.date}
Author: ${extract.author}

Original message:
${extract.message}

Files changed (diff --stat):
${extract.stat || "(no stat available)"}

Summary: ${extract.shortstat || "(no shortstat available)"}`;
};
