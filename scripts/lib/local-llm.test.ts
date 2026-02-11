import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import {
  callLocalLlm,
  extractResponseText,
  type LocalLlmRequest,
} from "./local-llm.ts";

// ---------------------------------------------------------------------------
// extractResponseText (pure, no I/O)
// ---------------------------------------------------------------------------

Deno.test("extractResponseText: extracts content from OpenAI format", () => {
  const body = {
    choices: [{ message: { role: "assistant", content: "Hello world" } }],
  };
  const result = extractResponseText(body);
  assert(result.ok);
  if (result.ok) assertEquals(result.value, "Hello world");
});

Deno.test("extractResponseText: trims whitespace", () => {
  const body = {
    choices: [{ message: { content: "  trimmed  \n" } }],
  };
  const result = extractResponseText(body);
  assert(result.ok);
  if (result.ok) assertEquals(result.value, "trimmed");
});

Deno.test("extractResponseText: joins array content parts", () => {
  const body = {
    choices: [{
      message: {
        content: [{ type: "text", text: "Hello " }, {
          type: "text",
          text: "world",
        }],
      },
    }],
  };
  const result = extractResponseText(body);
  assert(result.ok);
  if (result.ok) assertEquals(result.value, "Hello world");
});

Deno.test("extractResponseText: fails on empty choices", () => {
  const result = extractResponseText({ choices: [] });
  assert(!result.ok);
});

Deno.test("extractResponseText: fails on missing content", () => {
  const result = extractResponseText({ choices: [{ message: {} }] });
  assert(!result.ok);
});

Deno.test("extractResponseText: fails on null body", () => {
  const result = extractResponseText(null);
  assert(!result.ok);
});

// ---------------------------------------------------------------------------
// callLocalLlm with mock server
// ---------------------------------------------------------------------------

const makeRequest = (
  port: number,
  overrides: Partial<LocalLlmRequest> = {},
): LocalLlmRequest => ({
  endpoint: `http://localhost:${port}`,
  model: "test-model",
  messages: [{ role: "user", content: "test" }],
  maxTokens: 100,
  timeoutMs: 3000,
  ...overrides,
});

Deno.test("callLocalLlm: successful response", async () => {
  const server = Deno.serve({ port: 0, onListen() {} }, (_req) => {
    return new Response(
      JSON.stringify({
        choices: [{
          message: { role: "assistant", content: '{"scopes":["auth"]}' },
        }],
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  });

  const addr = server.addr;
  const result = await callLocalLlm(makeRequest(addr.port, { jsonMode: true }));
  assert(result.ok);
  if (result.ok) assertEquals(result.value, '{"scopes":["auth"]}');

  await server.shutdown();
});

Deno.test("callLocalLlm: sends json mode in request body", async () => {
  let receivedBody: Record<string, unknown> = {};
  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    receivedBody = await req.json() as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  });

  const addr = server.addr;
  await callLocalLlm(makeRequest(addr.port, { jsonMode: true }));

  const format = receivedBody.response_format as { type: string } | undefined;
  assertEquals(format?.type, "json_object");

  await server.shutdown();
});

Deno.test("callLocalLlm: non-200 response returns fail", async () => {
  const server = Deno.serve({ port: 0, onListen() {} }, (_req) => {
    return new Response("Internal Server Error", { status: 500 });
  });

  const addr = server.addr;
  const result = await callLocalLlm(makeRequest(addr.port));
  assert(!result.ok);
  if (!result.ok) {
    assert(result.error.message.includes("500"));
  }

  await server.shutdown();
});

Deno.test("callLocalLlm: timeout returns fail", async () => {
  const abortController = new AbortController();
  const server = Deno.serve({ port: 0, onListen() {} }, (_req) => {
    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => resolve(new Response("too late")), 10000);
      abortController.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve(new Response("cancelled"));
      });
    });
  });

  const addr = server.addr;
  const result = await callLocalLlm(makeRequest(addr.port, { timeoutMs: 100 }));
  assert(!result.ok);
  if (!result.ok) {
    assert(result.error.message.includes("timed out"));
  }

  abortController.abort();
  await server.shutdown();
});

Deno.test("callLocalLlm: connection refused returns fail", async () => {
  // Use a port that nothing is listening on
  const result = await callLocalLlm(makeRequest(19999, { timeoutMs: 1000 }));
  assert(!result.ok);
  if (!result.ok) {
    assert(
      result.error.message.includes("connection failed") ||
        result.error.message.includes("Connection refused"),
    );
  }
});

Deno.test("callLocalLlm: plain text response (no json mode)", async () => {
  const server = Deno.serve({ port: 0, onListen() {} }, (_req) => {
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "A plain summary of the context." } }],
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  });

  const addr = server.addr;
  const result = await callLocalLlm(makeRequest(addr.port));
  assert(result.ok);
  if (result.ok) assertEquals(result.value, "A plain summary of the context.");

  await server.shutdown();
});
