import { expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  buildSamHistoryTool,
  compactSamHistory,
  previewSamToolOutput,
} from "./samToolContext";

const rows = Array.from({ length: 50 }, (_, index) => ({
  page: `/page-${index}`,
  sessions: 100 - index,
}));
const result = () => ({
  summary: "Landing pages",
  data: {
    rows,
    totalRowCount: 500,
    request: {
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      channel: "organic_search",
    },
    totals: { sessions: 12345 },
    pageInfo: { offset: 0, nextOffset: 50, hasMore: true },
    warnings: ["thresholded"],
    source: { propertyId: "properties/123" },
  },
});
function message(id: string, output: unknown): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolName: "get_google_analytics_organic_landing_pages",
        toolCallId: id,
        state: "output-available",
        input: {},
        output,
      },
    ],
  };
}

it("previews relevant rows without changing source totals, provenance or source pagination", () => {
  const full = result();
  expect(previewSamToolOutput(full, { toolCallId: "call" })).toMatchObject({
    result: { ...full, data: { ...full.data, rows: rows.slice(0, 20) } },
    contextPreview: {
      toolCallId: "call",
      omitted: [{ path: "data.rows", shown: 20, available: 50, unit: "rows" }],
    },
  });
  expect(full.data.rows).toHaveLength(50);
});

it("reads omitted snapshot rows, including the final page, without fetching a connector", async () => {
  const reader = buildSamHistoryTool(async (ref) =>
    ref.toolCallId === "call" ? result() : undefined,
  );
  expect(
    await reader.execute?.(
      { toolCallId: "call", path: "data.rows", offset: 40, limit: 20 },
      { toolCallId: "read", messages: [] },
    ),
  ).toMatchObject({ data: rows.slice(40), available: 50, nextOffset: null });
  expect(
    await reader.execute?.(
      {
        toolCallId: "other-conversation",
        path: "data.rows",
        offset: 0,
        limit: 20,
      },
      { toolCallId: "missing", messages: [] },
    ),
  ).toHaveProperty("error");
  expect(
    await reader.execute?.(
      { toolCallId: "call", path: "__proto__", offset: 0, limit: 20 },
      { toolCallId: "invalid", messages: [] },
    ),
  ).toMatchObject({ error: "Invalid result path." });
});

it("compacts only old tool detail while preserving findings, dates, filters and private report links", () => {
  const reportUrl = "https://app.test/p/project/reports/report";
  const old = message("old-call", result());
  const report = message("report-call", {
    data: {
      title: "September findings",
      url: reportUrl,
      html: "<p>".repeat(1000),
    },
  });
  const finding: UIMessage = {
    id: "findings",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: `Organic sessions were 12345 in September; property 123. Report: ${reportUrl}`,
      },
    ],
  };
  const question: UIMessage = {
    id: "question",
    role: "user",
    parts: [{ type: "text", text: "Compare October" }],
  };
  const current = message("current-call", result());
  const projected = compactSamHistory([
    old,
    report,
    finding,
    question,
    current,
  ]);
  expect(projected[0].parts[0]).toMatchObject({
    output: {
      result: { data: { ...result().data, rows: rows.slice(0, 3) } },
      contextPreview: {
        messageId: "old-call",
        toolCallId: "old-call",
      },
    },
  });
  expect(projected[1].parts[0]).toMatchObject({
    output: {
      result: { data: { url: reportUrl, title: "September findings" } },
      contextPreview: { messageId: "report-call" },
    },
  });
  expect(projected.slice(2)).toEqual([finding, question, current]);
  expect(old.parts[0]).toMatchObject({ output: { data: { rows } } });
  const originalChars = JSON.stringify([
    old,
    report,
    finding,
    question,
    current,
  ]).length;
  const projectedChars = JSON.stringify(projected).length;
  expect(projectedChars).toBeLessThan(originalChars);
  process.stdout.write(
    `SAM history benchmark (serialized characters): ${JSON.stringify({ originalChars, projectedChars })}\n`,
  );
});

it("omits earlier report HTML arguments while retaining the saved title, findings and URL", () => {
  const html = `<html>${"<p>Finding</p>".repeat(300)}</html>`;
  const report: UIMessage = {
    id: "saved-report",
    role: "assistant",
    parts: [
      {
        type: "dynamic-tool",
        toolName: "create_report",
        toolCallId: "create",
        state: "output-available",
        input: { title: "Traffic review", summary: "Sessions grew 10%", html },
        output: { data: { url: "https://app.test/p/project/reports/report" } },
      },
    ],
  };
  const question: UIMessage = {
    id: "next",
    role: "user",
    parts: [{ type: "text", text: "What did that report find?" }],
  };
  const projected = compactSamHistory([report, question]);
  expect(projected[0].parts[0]).toMatchObject({
    input: { title: "Traffic review", summary: "Sessions grew 10%" },
    output: { data: { url: "https://app.test/p/project/reports/report" } },
  });
  expect(JSON.stringify(projected)).not.toContain(html);
  expect(report.parts[0]).toMatchObject({ input: { html } });
});

it.each([{ error: "GA4 unavailable" }, { data: { rows: [], totalCount: 0 } }])(
  "keeps small, empty and failed results intact (%j)",
  (value) => {
    expect(previewSamToolOutput(value, { toolCallId: "call" })).toEqual(value);
  },
);
