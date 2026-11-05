import { beforeEach, expect, it, vi } from "vitest";
import * as searchConsoleTools from "./search-console-tools";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({ GscService: { getPerformance: vi.fn() } }));
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/google/oauth-config", () => ({
  hasGoogleOAuthConfig: async () => true,
}));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: async () => ({ id: "project_1" }),
  },
}));
vi.mock("@/server/features/gsc/services/GscService", () => ({
  GscService: mocks.GscService,
}));
const toolContext = makeToolContext();
beforeEach(() => {
  mocks.GscService.getPerformance.mockResolvedValue({
    siteUrl: "https://example.com/",
    request: { startDate: "2026-08-01", endDate: "2026-09-30" },
    rows: [],
  });
});

it("returns monthly totals with weighted metrics and source coverage instead of daily rows", async () => {
  mocks.GscService.getPerformance.mockResolvedValue({
    siteUrl: "https://example.com/",
    request: {
      dimensions: ["date"],
      startDate: "2026-08-31",
      endDate: "2026-09-02",
    },
    rows: [
      {
        keys: ["2026-08-31"],
        clicks: 10,
        impressions: 100,
        ctr: 0.1,
        position: 2,
      },
      {
        keys: ["2026-09-01"],
        clicks: 20,
        impressions: 200,
        ctr: 0.1,
        position: 4,
      },
      {
        keys: ["2026-09-02"],
        clicks: 30,
        impressions: 100,
        ctr: 0.3,
        position: 10,
      },
    ],
  });
  const result =
    await searchConsoleTools.getSearchConsolePerformanceTool.handler(
      {
        projectId: "project_1",
        dimensions: ["date"],
        aggregation: "month",
        rowLimit: 1,
      },
      toolContext,
    );
  expect(result.structuredContent).toMatchObject({
    startDate: "2026-08-31",
    endDate: "2026-09-02",
    dimensions: ["month"],
    rowCount: 2,
    sourceRowCount: 3,
    hasMore: false,
    rows: [
      {
        keys: ["2026-08"],
        clicks: 10,
        impressions: 100,
        ctr: 0.1,
        position: 2,
        daysWithData: 1,
      },
      {
        keys: ["2026-09"],
        clicks: 50,
        impressions: 300,
        ctr: 0.1667,
        position: 6,
        daysWithData: 2,
      },
    ],
  });
  // Fetching the full source window is required for honest monthly totals.
  expect(mocks.GscService.getPerformance).toHaveBeenCalledWith(
    expect.objectContaining({ rowLimit: 1000 }),
  );
});

it("refuses to present monthly totals when the daily source hits its row cap", async () => {
  mocks.GscService.getPerformance.mockResolvedValue({
    siteUrl: "https://example.com/",
    request: { dimensions: ["date"] },
    rows: Array.from({ length: 1000 }, () => ({
      keys: ["2026-08-01"],
      clicks: 1,
      impressions: 10,
      ctr: 0.1,
    })),
  });
  const result =
    await searchConsoleTools.getSearchConsolePerformanceTool.handler(
      { projectId: "project_1", dimensions: ["date"], aggregation: "month" },
      toolContext,
    );
  expect(result.structuredContent).toMatchObject({
    ok: false,
    reason: "invalid_request",
  });
  expect(textContent(result)).toContain("partial totals");
});

it.each([
  { dimensions: ["query"] as ["query"] },
  { dimensions: ["date"] as ["date"], startRow: 10 },
  { dimensions: ["date"] as ["date"], minImpressions: 100 },
])(
  "rejects monthly requests that could produce misleading totals (%j)",
  async (input) => {
    const result =
      await searchConsoleTools.getSearchConsolePerformanceTool.handler(
        { projectId: "project_1", aggregation: "month", ...input },
        toolContext,
      );
    expect(result.structuredContent).toMatchObject({
      ok: false,
      reason: "invalid_request",
    });
    expect(mocks.GscService.getPerformance).not.toHaveBeenCalled();
  },
);
