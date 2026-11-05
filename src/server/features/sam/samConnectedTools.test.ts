import { beforeEach, expect, it, vi } from "vitest";
import { buildSamMcpTools } from "./samChatTools";
import { makeToolContext } from "@/server/mcp/tools/tool-test-support";
import { makeGa4ReportResult } from "@/server/features/ga4/services/ga4-test-fixtures";
import { asSchema, type ToolSet } from "ai";
import { SamToolCatalog } from "./SamToolCatalog";
import { buildSamHistoryTool } from "./samToolContext";

const mocks = vi.hoisted(() => ({
  role: vi.fn(),
  project: vi.fn(),
  runReport: vi.fn(),
  performance: vi.fn(),
  keywords: vi.fn(),
  insertReport: vi.fn(),
  getReport: vi.fn(),
  findReportByTitle: vi.fn(),
  countReports: vi.fn(),
  sumReportBytesForOrganization: vi.fn(),
  updateReportContent: vi.fn(),
}));
vi.mock("cloudflare:workers", () => ({
  env: {},
  waitUntil: vi.fn(),
  DurableObject: class {
    kind = "mock";
  },
}));
vi.mock("@/db", () => ({
  db: {},
  withPgClient: async (fn: () => unknown) => fn(),
}));
vi.mock("./samToolAuth", () => ({ resolveSamToolRole: mocks.role }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: { getProjectForOrganization: mocks.project },
}));
vi.mock("@/server/features/ga4/services/Ga4ReportingService", () => ({
  Ga4ReportingService: { runReport: mocks.runReport },
}));
vi.mock("@/server/features/gsc/services/GscService", () => ({
  GscService: { getPerformance: mocks.performance },
}));
vi.mock("@/server/features/google/oauth-config", () => ({
  hasGoogleOAuthConfig: async () => true,
}));
vi.mock("@/server/features/keywords/services/KeywordResearchService", () => ({
  KeywordResearchService: { getSavedKeywords: mocks.keywords },
}));
vi.mock("@/server/features/reports/repositories/ReportRepository", () => ({
  ReportRepository: mocks,
}));
vi.mock("@/server/lib/posthog", () => ({
  captureServerEvent: async () => {},
  captureServerError: async () => {},
}));
vi.mock("@/server/mcp/instrumentation", () => ({
  instrumentMcpToolHandler: (
    _name: string,
    _schema: unknown,
    handler: unknown,
  ) => handler,
}));

const tools = () =>
  buildSamMcpTools(
    makeToolContext().auth,
    { id: "project_1", domain: "example.com" },
    "turn",
    "connected_data",
  );
const call = async (
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> =>
  tools()[name].execute?.(args, { toolCallId: "call", messages: [] });

it("uses bounded connected-data defaults while retaining the full profile's original defaults", async () => {
  const connected = tools();
  expect(
    await asSchema(
      connected.get_google_analytics_organic_landing_pages.inputSchema,
    ).validate?.({}),
  ).toMatchObject({ success: true, value: { limit: 20, offset: 0 } });
  expect(
    await asSchema(connected.list_saved_keywords.inputSchema).validate?.({}),
  ).toMatchObject({
    success: true,
    value: { limit: 50, sort: "searchVolume" },
  });
  expect(
    await asSchema(
      connected.get_google_analytics_organic_overview.inputSchema,
    ).validate?.({}),
  ).toMatchObject({ success: true, value: { trend: "weekly" } });
  const full = buildSamMcpTools(makeToolContext().auth, {
    id: "project_1",
    domain: "example.com",
  });
  expect(
    await asSchema(
      full.get_google_analytics_organic_landing_pages.inputSchema,
    ).validate?.({}),
  ).toMatchObject({ success: true, value: { limit: 100 } });
  expect(
    await asSchema(
      full.get_google_analytics_organic_overview.inputSchema,
    ).validate?.({}),
  ).toMatchObject({ success: true, value: { trend: "daily" } });
});

it("reduces schema payloads for representative questions without hiding required specialists", async () => {
  const definitions = tools();
  const bytes = async (map: ToolSet, names: string[]) =>
    JSON.stringify(
      await Promise.all(
        names.map(async (name) => ({
          name,
          description: map[name].description,
          schema: await asSchema(map[name].inputSchema).jsonSchema,
        })),
      ),
    ).length;
  const allDefinitions = await bytes(definitions, Object.keys(definitions));
  const cases = [
    {
      question: "Compare monthly Search Console clicks and impressions",
      load: [],
    },
    {
      question: "Which landing pages convert from organic traffic?",
      load: ["get_google_analytics_organic_landing_pages"],
    },
    {
      question: "Find opportunities in our saved keywords",
      load: ["list_saved_keywords"],
    },
    {
      question: "Compare sources and save a private report",
      load: ["get_search_opportunities", "create_report"],
    },
  ];
  const measurements = [];
  for (const scenario of cases) {
    const catalog = new SamToolCatalog({
      ...definitions,
      read_tool_result: buildSamHistoryTool(async () => undefined),
    });
    if (scenario.load.length)
      await catalog.tools.load_tools.execute?.(
        { names: scenario.load },
        { toolCallId: "load", messages: [] },
      );
    for (const name of scenario.load)
      expect(catalog.canExecute(name)).toBe(true);
    const loadedDefinitions = await bytes(catalog.tools, catalog.activeTools);
    expect(loadedDefinitions).toBeLessThan(allDefinitions);
    measurements.push({
      question: scenario.question,
      allSchemaChars: allDefinitions,
      loadedSchemaChars: loadedDefinitions,
      activeTools: catalog.activeTools.length,
    });
  }
  process.stdout.write(
    `SAM schema benchmark (serialized characters, not billed tokens): ${JSON.stringify(measurements)}\n`,
  );
});

it("keeps an entire bounded source page in storage while sending the model only its preview", async () => {
  const rows = Array.from({ length: 50 }, (_, index) => ({
    landingPage: `/page-${index}`,
    sessions: index + 1,
  }));
  mocks.runReport.mockResolvedValue(
    makeGa4ReportResult({
      rows,
      rowCount: 50,
      totalRowCount: 125,
      pageInfo: { limit: 50, hasMore: true, nextOffset: 50 },
    }),
  );
  const definition = tools().get_google_analytics_organic_landing_pages;
  const raw: unknown = await definition.execute?.(
    { limit: 50, offset: 0 },
    { toolCallId: "read", messages: [] },
  );
  expect(raw).toMatchObject({
    data: { rows, totalRowCount: 125, pageInfo: { nextOffset: 50 } },
  });
  expect(
    await definition.toModelOutput?.({
      output: raw,
      toolCallId: "read",
      input: {},
    }),
  ).toMatchObject({
    type: "json",
    value: {
      result: {
        data: {
          rows: rows.slice(0, 20),
          totalRowCount: 125,
          pageInfo: { nextOffset: 50 },
        },
      },
      contextPreview: {
        omitted: [{ path: "data.rows", shown: 20, available: 50 }],
      },
    },
  });
});

beforeEach(() => {
  mocks.role.mockResolvedValue("member");
  mocks.project.mockImplementation(async (_org: string, id: string) =>
    id === "project_1" ? { id } : null,
  );
  mocks.runReport.mockResolvedValue(
    makeGa4ReportResult({
      rows: [{ landingPage: "/pricing", sessions: 42 }],
      rowCount: 1,
      totalRowCount: 1,
    }),
  );
  mocks.performance.mockResolvedValue({
    siteUrl: "sc-domain:example.com",
    request: {
      startDate: "2026-07-09",
      endDate: "2026-08-05",
      dimensions: ["page"],
    },
    rows: [
      {
        keys: ["https://example.com/pricing"],
        clicks: 32,
        impressions: 200,
        ctr: 0.16,
        position: 4,
      },
    ],
  });
  mocks.keywords.mockResolvedValue({ rows: [], totalCount: 0, tags: [] });
  mocks.findReportByTitle.mockResolvedValue(null);
  mocks.countReports.mockResolvedValue(0);
  mocks.sumReportBytesForOrganization.mockResolvedValue(0);
  mocks.insertReport.mockResolvedValue(undefined);
  mocks.getReport.mockResolvedValue(null);
});

it("exposes only connected reads and create-only reports while preserving the full profile", () => {
  expect(new Set(Object.keys(tools()))).toEqual(
    new Set([
      "create_report",
      "get_project_context",
      "list_saved_keywords",
      "get_search_console_performance",
      "inspect_urls",
      "get_google_analytics_organic_landing_pages",
      "get_google_analytics_page_performance",
      "get_google_analytics_key_events",
      "get_search_opportunities",
      "get_google_analytics_organic_overview",
      "get_google_analytics_traffic_acquisition",
      "get_google_analytics_measurement_health",
      "get_google_analytics_ecommerce_performance",
      "get_google_analytics_site_search",
      "get_google_analytics_audience_breakdown",
      "list_reports",
      "get_report",
    ]),
  );
  expect(
    buildSamMcpTools(makeToolContext().auth, { id: "project_1", domain: null }),
  ).toHaveProperty("research_keywords");
});

it("binds connector reads to the session project even when a model supplies another project", async () => {
  expect(
    await call("get_google_analytics_organic_landing_pages", {
      projectId: "foreign",
      limit: 100,
      offset: 0,
    }),
  ).toMatchObject({
    data: { rows: [{ landingPage: "/pricing", sessions: 42 }] },
  });
  expect(
    await call("get_search_console_performance", { projectId: "foreign" }),
  ).toMatchObject({
    data: { siteUrl: "sc-domain:example.com", rows: [{ clicks: 32 }] },
  });
  // Project binding is an authorization contract, so these mappings matter.
  expect(mocks.runReport).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: "project_1" }),
  );
  expect(mocks.performance).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: "project_1" }),
  );
});

it("returns empty saved data and connector failures without aborting other tools", async () => {
  mocks.runReport.mockRejectedValue(new Error("Connector unavailable"));
  expect(
    await call("get_google_analytics_organic_landing_pages", {
      limit: 100,
      offset: 0,
    }),
  ).toMatchObject({ error: "Connector unavailable" });
  expect(await call("list_saved_keywords")).toMatchObject({
    data: { rows: [], totalCount: 0 },
  });
  expect(await call("get_search_console_performance")).toMatchObject({
    data: { ok: true },
  });
});

it("revokes tools for a member removed during an open chat", async () => {
  mocks.role.mockResolvedValue(null);
  expect(await call("list_saved_keywords")).toHaveProperty(
    "error",
    "You no longer have access to this organization.",
  );
  expect(mocks.keywords).not.toHaveBeenCalled();
});

it("creates a private report with an app link and ignores overwrite and sharing inputs", async () => {
  const result = await call("create_report", {
    projectId: "foreign",
    reportId: "existing",
    shareToken: "publish",
    title: "Traffic findings, November 4, 2026",
    summary: "Traffic declined.",
    html: "<html><body><h1>Traffic findings</h1></body></html>",
  });
  expect(result).toMatchObject({
    data: {
      created: true,
    },
  });
  expect(result).toHaveProperty(
    "data.url",
    expect.stringMatching(/^https:\/\/open-seo.test\/p\/project_1\/reports\//),
  );
  expect(mocks.insertReport).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: "project_1",
      createdByUserId: "user_123",
    }),
  );
  expect(mocks.insertReport.mock.calls[0][0]).not.toHaveProperty("shareToken");
  expect(mocks.updateReportContent).not.toHaveBeenCalled();
  expect(mocks.getReport).not.toHaveBeenCalled();
});
