/**
 * OpenAI chat completions client for Ollama and compatible runtimes.
 *
 * Raw fetch to {endpoint}/v1/chat/completions, no SDK dependency.
 * Single attempt (no retries) - hooks must stay fast.
 * Returns Result<string> per project conventions.
 */

import { Result } from "../types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface LocalLlmRequest {
  readonly endpoint: string;
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly maxTokens: number;
  readonly timeoutMs: number;
  readonly jsonMode?: boolean;
}

// ---------------------------------------------------------------------------
// Response Extraction
// ---------------------------------------------------------------------------

interface OpenAiChoice {
  readonly message?: {
    readonly content?:
      | string
      | readonly { readonly type?: string; readonly text?: string }[];
  };
}

interface OpenAiResponse {
  readonly choices?: readonly OpenAiChoice[];
}

export const extractResponseText = (body: unknown): Result<string> => {
  const resp = body as OpenAiResponse;
  const content = resp?.choices?.[0]?.message?.content;

  if (typeof content === "string" && content.trim().length > 0) {
    return Result.ok(content.trim());
  }

  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("")
      .trim();
    if (joined.length > 0) return Result.ok(joined);
  }

  return Result.fail(new Error("No content in response"));
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export const callLocalLlm = async (
  req: LocalLlmRequest,
): Promise<Result<string>> => {
  const url = `${req.endpoint}/v1/chat/completions`;

  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    max_tokens: req.maxTokens,
    stream: false,
  };

  if (req.jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    clearTimeout(timer);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return Result.fail(
        new Error(
          `LLM request failed ${response.status}: ${text.slice(0, 200)}`,
        ),
      );
    }

    const json: unknown = await response.json();
    return extractResponseText(json);
  } catch (e) {
    clearTimeout(timer);

    if (e instanceof DOMException && e.name === "AbortError") {
      return Result.fail(
        new Error(`LLM request timed out after ${req.timeoutMs}ms`),
      );
    }

    // Connection refused, network error, etc.
    const message = e instanceof Error ? e.message : String(e);
    return Result.fail(new Error(`LLM connection failed: ${message}`));
  }
};
