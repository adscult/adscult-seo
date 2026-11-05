import { expect, it } from "vitest";
import { toSamThreadMessage } from "./samMessages";
import type { UIMessage } from "ai";

it("preserves message IDs, part order, and tool results for the assistant-ui runtime", () => {
  const result = toSamThreadMessage({
    id: "answer-1",
    role: "assistant",
    parts: [
      { type: "text", text: "Checking Search Console." },
      {
        type: "dynamic-tool",
        toolName: "get_search_console_performance",
        toolCallId: "gsc-1",
        state: "output-available",
        input: { projectId: "project-1" },
        output: { data: { rows: [{ clicks: 42 }] } },
      },
      { type: "text", text: "The page received 42 clicks." },
    ],
  });
  expect(result).toMatchObject({
    id: "answer-1",
    role: "assistant",
    content: [
      { type: "text", text: "Checking Search Console." },
      {
        type: "tool-call",
        toolName: "get_search_console_performance",
        toolCallId: "gsc-1",
        result: { data: { rows: [{ clicks: 42 }] } },
        isError: false,
      },
      { type: "text", text: "The page received 42 clicks." },
    ],
  });
});

it("keeps progress live only on the running assistant message", () => {
  const message: UIMessage = {
    id: "answer-1",
    role: "assistant",
    parts: [
      {
        type: "reasoning",
        text: "Comparing the reporting periods",
        state: "streaming",
      },
      {
        type: "tool-get_search_console_performance",
        toolCallId: "gsc-1",
        state: "input-available",
        input: {},
      },
    ],
  };
  expect(toSamThreadMessage(message, true)).toMatchObject({
    status: { type: "running" },
    content: [
      { type: "reasoning", status: { type: "running" } },
      { type: "tool-call", result: undefined, isError: false },
    ],
  });
  expect(toSamThreadMessage(message)).toMatchObject({
    status: { type: "complete" },
    content: [
      { type: "reasoning", status: { type: "complete" } },
      {
        type: "tool-call",
        result: "This tool call was interrupted.",
        isError: true,
      },
    ],
  });
});

it.each([
  { error: "Connector unavailable" },
  { data: { status: "error", error: { code: "not_connected" } } },
  { data: { ok: false, reason: "not_connected" } },
])("marks a connector's returned failure as an error (%j)", (output) => {
  expect(
    toSamThreadMessage({
      id: "answer-1",
      role: "assistant",
      parts: [
        {
          type: "tool-get_google_analytics_organic_overview",
          toolCallId: "ga4-1",
          state: "output-available",
          input: {},
          output,
        },
      ],
    }),
  ).toMatchObject({
    content: [{ type: "tool-call", isError: true, result: output }],
  });
});

it("preserves a provider tool failure instead of leaving it running", () => {
  expect(
    toSamThreadMessage(
      {
        id: "answer-1",
        role: "assistant",
        parts: [
          {
            type: "tool-get_google_analytics_organic_overview",
            toolCallId: "ga4-1",
            state: "output-error",
            input: {},
            errorText: "Permission denied",
          },
        ],
      },
      true,
    ),
  ).toMatchObject({
    content: [
      { type: "tool-call", isError: true, result: "Permission denied" },
    ],
  });
});
