import { generateText, streamText } from "ai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildSamModel } from "./samModel";
import { z } from "zod";

const finish = vi.hoisted(() => vi.fn());
vi.mock("@/db", () => ({ withPgClient: async (fn: () => unknown) => fn() }));
vi.mock("./SamUsageRepository", () => ({ SamUsageRepository: { finish } }));

beforeEach(() => {
  finish.mockResolvedValue(undefined);
  vi.stubEnv("ANTHROPIC_MODEL", "claude-sonnet-4-6");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([
  ["max", undefined, "claude-sonnet-4-6", undefined],
  ["max", "claude-opus-4-6", "claude-opus-4-6", undefined],
  ["low", "claude-opus-4-6", "claude-opus-4-6", undefined],
  [
    "max",
    "custom-allowed-model",
    "custom-allowed-model",
    "custom-allowed-model",
  ],
] as const)(
  "uses the selected Anthropic model for %s calls (%s), counting cached input once",
  async (effort, selectedModel, expectedModel, configuredModels) => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        id: "msg-test",
        type: "message",
        role: "assistant",
        model: expectedModel,
        content: [{ type: "text", text: "Measured traffic fell 12%." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 30,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("SAM_PROVIDER", "anthropic");
    vi.stubEnv("SAM_MODELS", configuredModels ?? "");
    vi.stubEnv("ANTHROPIC_API_KEY", "fixture-key");
    const admit = vi.fn().mockResolvedValue("call-1");
    const result = await generateText({
      model: buildSamModel({}, effort, admit, selectedModel),
      prompt: "Analyze traffic",
      maxRetries: 0,
    });
    expect(result.text).toBe("Measured traffic fell 12%.");
    expect(String(fetchMock.mock.calls[0][0])).toContain("api.anthropic.com");
    expect(admit).toHaveBeenCalledWith("anthropic", expectedModel);
    const request = z
      .object({ body: z.string() })
      .parse(fetchMock.mock.calls[0][1]);
    const body: unknown = JSON.parse(request.body);
    expect(body).toMatchObject({ model: expectedModel });
    expect(finish.mock.calls[0]).toMatchObject([
      "call-1",
      { inputTokens: { total: 180 }, outputTokens: { total: 20 } },
    ]);
  },
);

it("keeps OpenRouter selected when SAM_PROVIDER is unset", async () => {
  vi.stubEnv("SAM_PROVIDER", "");
  vi.stubEnv("OPENROUTER_MODEL", "minimax/minimax-m3");
  vi.stubEnv("OPENROUTER_API_KEY", "fixture-key");
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({
      choices: [
        {
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const result = await generateText({
    model: buildSamModel({}, "max", async () => "router-call"),
    prompt: "hi",
    maxRetries: 0,
  });
  expect(result.text).toBe("ok");
  expect(String(fetchMock.mock.calls[0][0])).toContain("openrouter.ai");
  expect(finish.mock.calls[0]).toMatchObject([
    "router-call",
    { inputTokens: { total: 10 } },
  ]);
});

it("never calls a provider when admission is refused", async () => {
  vi.stubEnv("SAM_PROVIDER", "anthropic");
  vi.stubEnv("ANTHROPIC_API_KEY", "fixture-key");
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    generateText({
      model: buildSamModel({}, "max", async () => {
        throw new Error("daily token allowance is exhausted");
      }),
      prompt: "hi",
      maxRetries: 0,
    }),
  ).rejects.toThrow("allowance is exhausted");
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([401, 429])(
  "explains provider failure %s without switching providers",
  async (status) => {
    vi.stubEnv("SAM_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "fixture-key");
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(
        {
          type: "error",
          error: { type: "authentication_error", message: "fixture" },
        },
        { status },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      generateText({
        model: buildSamModel({}, "max", async () => "failed-call"),
        prompt: "hi",
        maxRetries: 0,
      }),
    ).rejects.toThrow(
      status === 401 ? "credentials were rejected" : "rate or credit limit",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith("failed-call", undefined);
  },
);

it("persists streamed usage before admitting the next call", async () => {
  vi.stubEnv("SAM_PROVIDER", "anthropic");
  vi.stubEnv("ANTHROPIC_API_KEY", "fixture-key");
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg-stream",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        usage: {
          input_tokens: 100,
          output_tokens: 0,
          cache_read_input_tokens: 50,
        },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Saved findings." },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 12 },
    },
    { type: "message_stop" },
  ];
  const body = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(body, {
        headers: { "content-type": "text/event-stream" },
      }),
    ),
  );
  const model = buildSamModel({}, "max", async () => "stream-call");
  const result = streamText({ model, prompt: "Save findings", maxRetries: 0 });
  expect(await result.text).toBe("Saved findings.");
  expect(finish.mock.calls[0]).toMatchObject([
    "stream-call",
    { inputTokens: { total: 150 }, outputTokens: { total: 12 } },
  ]);
});

it("records cancellation without waiting for a provider finish event", async () => {
  vi.stubEnv("SAM_PROVIDER", "anthropic");
  vi.stubEnv("ANTHROPIC_API_KEY", "fixture-key");
  const start = {
    type: "message_start",
    message: {
      id: "msg-cancel",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [],
      usage: { input_tokens: 100, output_tokens: 0 },
    },
  };
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          `event: message_start\ndata: ${JSON.stringify(start)}\n\n`,
        ),
      );
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(source, {
        headers: { "content-type": "text/event-stream" },
      }),
    ),
  );
  const model = buildSamModel({}, "max", async () => "cancelled-call");
  const result = await model.doStream({ prompt: [], maxOutputTokens: 8000 });
  await result.stream.cancel();
  expect(finish).toHaveBeenCalledWith("cancelled-call", undefined);
});
