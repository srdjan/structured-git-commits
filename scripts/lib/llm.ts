/**
 * Thin Claude API client using raw fetch. No SDK dependency.
 *
 * Handles HTTP errors, 429 retry-after, 30s timeout, and response
 * text extraction. Returns Result<string> per project conventions.
 */

import { Result } from "../types.ts";

const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;

type LlmRequest = {
  readonly system: string;
  readonly user: string;
  readonly apiKey: string;
  readonly model?: string;
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const extractText = (body: unknown): Result<string> => {
  const obj = body as {
    content?: ReadonlyArray<{ type: string; text?: string }>;
  };
  if (!obj.content || obj.content.length === 0) {
    return Result.fail(new Error("Empty response content from API"));
  }
  const textBlock = obj.content.find((b) => b.type === "text");
  if (!textBlock?.text) {
    return Result.fail(new Error("No text block in API response"));
  }
  return Result.ok(textBlock.text.trim());
};

export const callClaude = async (
  req: LlmRequest,
): Promise<Result<string>> => {
  const model = req.model ?? DEFAULT_MODEL;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": req.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
        }),
      });

      clearTimeout(timer);

      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
        if (attempt < MAX_RETRIES) {
          await delay(waitMs);
          continue;
        }
        return Result.fail(new Error("Rate limited after retries"));
      }

      if (!response.ok) {
        const text = await response.text();
        return Result.fail(
          new Error(`API error ${response.status}: ${text.slice(0, 200)}`),
        );
      }

      const json = await response.json();
      return extractText(json);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        return Result.fail(new Error("API request timed out after 30s"));
      }
      if (attempt < MAX_RETRIES) {
        await delay(1000 * (attempt + 1));
        continue;
      }
      return Result.fail(e instanceof Error ? e : new Error(String(e)));
    }
  }

  return Result.fail(new Error("Exhausted retries"));
};
