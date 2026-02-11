/**
 * Pure functions for LLM-enhanced sub-calls in the RLM pattern.
 *
 * Each sub-call builds a prompt, calls the local LLM, and parses
 * the response. Prompt building and response parsing are exposed
 * as pure functions for direct testing without HTTP mocking.
 *
 * Sub-calls:
 *   1. analyzePromptWithLlm - smart prompt analysis (replaces keyword matching)
 *   2. generateFollowUpQueries - recursive follow-up query generation
 *   3. summarizeContext - context compression before injection
 *   4. analyzeBridgeContext - bridge context summarization
 */

import type { IntentType } from "../types.ts";
import { INTENT_TYPES, Result } from "../types.ts";
import type { RlmConfig } from "./rlm-config.ts";
import { callLocalLlm, type ChatMessage } from "./local-llm.ts";

const normalizeJsonPayload = (text: string): string =>
  text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/\s*\/think\s*$/i, "")
    .trim();

const parseJsonObject = (text: string): Record<string, unknown> | null => {
  const normalized = normalizeJsonPayload(text);
  const tryParse = (candidate: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  };

  const direct = tryParse(normalized);
  if (direct) return direct;

  const start = normalized.indexOf("{");
  const end = normalized.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return tryParse(normalized.slice(start, end + 1));
  }

  return null;
};

export const getEffectiveSubcallLimits = (
  config: RlmConfig,
): { readonly timeoutMs: number; readonly maxTokens: number } => {
  const model = config.model.toLowerCase();
  const isQwen3 = model.startsWith("qwen3:");

  if (isQwen3) {
    return {
      timeoutMs: Math.max(config.timeoutMs, 20_000),
      maxTokens: Math.max(config.maxTokens, 1_024),
    };
  }

  return {
    timeoutMs: config.timeoutMs,
    maxTokens: config.maxTokens,
  };
};

// ---------------------------------------------------------------------------
// Sub-call 1: Smart Prompt Analysis
// ---------------------------------------------------------------------------

export interface LlmPromptSignals {
  readonly scopes: readonly string[];
  readonly intents: readonly IntentType[];
  readonly keywords: readonly string[];
}

const EMPTY_SIGNALS: LlmPromptSignals = {
  scopes: [],
  intents: [],
  keywords: [],
};

export const buildAnalyzePrompt = (
  prompt: string,
  scopeKeys: readonly string[],
): readonly ChatMessage[] => {
  const topScopes = scopeKeys.slice(0, 30).join(", ");
  const intentList = INTENT_TYPES.join(", ");

  return [
    {
      role: "system",
      content: `Extract the relevant scopes and intents from a user prompt.

Available scopes: ${topScopes}
Available intents: ${intentList}

Respond ONLY with JSON: {"scopes": ["scope1"], "intents": ["intent1"], "keywords": ["other", "terms"]}
- scopes: which available scopes relate to this prompt (0-5)
- intents: which intents match (0-2)
- keywords: other significant terms not captured by scopes/intents (0-5)`,
    },
    {
      role: "user",
      content: prompt,
    },
  ];
};

export const parseAnalyzeResponse = (
  text: string,
  validScopes: ReadonlySet<string>,
): LlmPromptSignals => {
  try {
    const data = parseJsonObject(text);
    if (!data) return EMPTY_SIGNALS;

    const rawScopes = Array.isArray(data.scopes) ? data.scopes : [];
    const rawIntents = Array.isArray(data.intents) ? data.intents : [];
    const rawKeywords = Array.isArray(data.keywords) ? data.keywords : [];

    const scopes = rawScopes
      .filter((s): s is string => typeof s === "string" && validScopes.has(s))
      .slice(0, 5);

    const intents = rawIntents
      .filter((i): i is IntentType =>
        typeof i === "string" && (INTENT_TYPES as readonly string[]).includes(i)
      )
      .slice(0, 2);

    const keywords = rawKeywords
      .filter((k): k is string => typeof k === "string" && k.length > 0)
      .slice(0, 5);

    return { scopes, intents, keywords };
  } catch {
    return EMPTY_SIGNALS;
  }
};

export const analyzePromptWithLlm = async (
  config: RlmConfig,
  prompt: string,
  scopeKeys: readonly string[],
): Promise<Result<LlmPromptSignals>> => {
  const limits = getEffectiveSubcallLimits(config);
  const messages = buildAnalyzePrompt(prompt, scopeKeys);
  const validScopes = new Set(scopeKeys);

  const result = await callLocalLlm({
    endpoint: config.endpoint,
    model: config.model,
    messages,
    maxTokens: limits.maxTokens,
    timeoutMs: limits.timeoutMs,
    jsonMode: true,
  });

  if (!result.ok) return result as Result<never>;
  return Result.ok(parseAnalyzeResponse(result.value, validScopes));
};

// ---------------------------------------------------------------------------
// Sub-call 2: Follow-up Query Generation (Recursive)
// ---------------------------------------------------------------------------

export interface FollowUpQuery {
  readonly scope: string | null;
  readonly intent: IntentType | null;
  readonly decidedAgainst: string | null;
}

export const buildFollowUpPrompt = (
  prompt: string,
  currentContext: string,
): readonly ChatMessage[] => [
  {
    role: "system",
    content:
      `The user asked a question. Current context was retrieved from git history.
If the context is insufficient, suggest 0-2 additional queries to find more relevant information.
Each query can filter by scope (path like "auth/login"), intent, or decided-against keyword.

Respond ONLY with JSON: {"queries": [{"scope": "auth", "intent": "fix-defect", "decidedAgainst": null}]}
Respond with {"queries": []} if the current context is sufficient.`,
  },
  {
    role: "user",
    content: `User prompt: "${prompt}"

Current context from git history:
${currentContext}`,
  },
];

export const parseFollowUpResponse = (
  text: string,
  validScopes: ReadonlySet<string>,
): readonly FollowUpQuery[] => {
  try {
    const data = parseJsonObject(text);
    if (!data) return [];
    const rawQueries = Array.isArray(data.queries) ? data.queries : [];

    return rawQueries
      .slice(0, 2)
      .map((q: Record<string, unknown>) => ({
        scope: typeof q.scope === "string" && validScopes.has(q.scope)
          ? q.scope
          : null,
        intent: typeof q.intent === "string" &&
            (INTENT_TYPES as readonly string[]).includes(q.intent)
          ? (q.intent as IntentType)
          : null,
        decidedAgainst: typeof q.decidedAgainst === "string"
          ? q.decidedAgainst
          : null,
      }))
      .filter((q) =>
        q.scope !== null || q.intent !== null || q.decidedAgainst !== null
      );
  } catch {
    return [];
  }
};

export const generateFollowUpQueries = async (
  config: RlmConfig,
  prompt: string,
  currentContext: string,
  validScopes: ReadonlySet<string>,
): Promise<Result<readonly FollowUpQuery[]>> => {
  const limits = getEffectiveSubcallLimits(config);
  const messages = buildFollowUpPrompt(prompt, currentContext);

  const result = await callLocalLlm({
    endpoint: config.endpoint,
    model: config.model,
    messages,
    maxTokens: limits.maxTokens,
    timeoutMs: limits.timeoutMs,
    jsonMode: true,
  });

  if (!result.ok) return result as Result<never>;
  return Result.ok(parseFollowUpResponse(result.value, validScopes));
};

// ---------------------------------------------------------------------------
// Sub-call 3: Context Summarization
// ---------------------------------------------------------------------------

export const buildSummarizePrompt = (
  prompt: string,
  fullContext: string,
): readonly ChatMessage[] => [
  {
    role: "system",
    content:
      `Summarize the most relevant information from git history for the user's task.
Write 3-5 concise lines highlighting:
- Recent relevant changes
- Decisions that constrain the approach
- Patterns or conventions to follow`,
  },
  {
    role: "user",
    content: `User's task: "${prompt}"

Git history context:
${fullContext}`,
  },
];

export const summarizeContext = async (
  config: RlmConfig,
  prompt: string,
  fullContext: string,
): Promise<Result<string>> => {
  const limits = getEffectiveSubcallLimits(config);
  const messages = buildSummarizePrompt(prompt, fullContext);

  return await callLocalLlm({
    endpoint: config.endpoint,
    model: config.model,
    messages,
    maxTokens: limits.maxTokens,
    timeoutMs: limits.timeoutMs,
  });
};

// ---------------------------------------------------------------------------
// Sub-call 4: Bridge Context Analysis
// ---------------------------------------------------------------------------

export const buildBridgePrompt = (
  queryCommand: string,
  queryResults: string,
  relatedDecisions: string,
  siblingScopes: string,
): readonly ChatMessage[] => [
  {
    role: "system",
    content:
      `A developer ran a git query. Highlight the most important related context they should know about.
Focus on: decisions that constrain their approach, patterns in sibling scopes, potential conflicts.
Write 2-4 concise lines.`,
  },
  {
    role: "user",
    content: `Query: ${queryCommand}

Query results: ${queryResults}

Related decided-against entries:
${relatedDecisions || "(none)"}

Related scopes:
${siblingScopes || "(none)"}`,
  },
];

export const analyzeBridgeContext = async (
  config: RlmConfig,
  queryCommand: string,
  queryResults: string,
  relatedDecisions: string,
  siblingScopes: string,
): Promise<Result<string>> => {
  const limits = getEffectiveSubcallLimits(config);
  const messages = buildBridgePrompt(
    queryCommand,
    queryResults,
    relatedDecisions,
    siblingScopes,
  );

  return await callLocalLlm({
    endpoint: config.endpoint,
    model: config.model,
    messages,
    maxTokens: limits.maxTokens,
    timeoutMs: limits.timeoutMs,
  });
};
