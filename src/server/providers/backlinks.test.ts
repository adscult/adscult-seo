import { beforeEach, expect, it, vi } from "vitest";
import { fetchBacklinksOverview, fetchBacklinksPage } from "./backlinks";

const mocks = vi.hoisted(() => ({
  summary: vi.fn(),
  history: vi.fn(),
  rows: vi.fn(),
  execution: vi.fn(),
}));
vi.mock("@/server/providers/resolver", () => ({
  resolveProviderExecution: mocks.execution,
}));
vi.mock("@/server/lib/dataforseo", async () => ({
  ...(await import("@/server/lib/dataforseoBacklinksTarget")),
  createDataforseoClient: () => ({
    backlinks: {
      summary: mocks.summary,
      history: mocks.history,
      rows: mocks.rows,
    },
  }),
}));
const customer = {
  organizationId: "organization",
  userId: "user",
  userEmail: "user@example.com",
};
beforeEach(() => {
  mocks.execution.mockResolvedValue({
    organizationId: customer.organizationId,
    provider: "dataforseo",
    revision: 3,
    credentialVersion: null,
    source: "environment",
    authorization: "server-only",
  });
  mocks.summary.mockResolvedValue({ backlinks: 0, private_payload: "raw" });
  mocks.history.mockResolvedValue([]);
  mocks.rows.mockResolvedValue({
    items: [
      {
        url_from: "https://source.example/link",
        url_to: "https://www.rkumar.in/collections/frame-montana",
        rank: 0,
      },
    ],
    totalCount: 2,
  });
});

it("declares backlink metric identity and keeps unavailable page history and scores distinct from measured zero", async () => {
  const result = await fetchBacklinksOverview(customer, {
    target: "https://example.com/post",
    scope: "exact_url",
  });
  expect(result).toMatchObject({
    ok: true,
    data: {
      overview: {
        scope: "exact_url",
        summary: { backlinks: 0, rank: null },
        trends: [],
      },
    },
    meta: {
      scope: { researchScope: "exact_url" },
      metricDefinitions: { rank: "dataforseo_backlinks_rank_0_100" },
    },
  });
  expect(result.meta.warnings).toHaveLength(1);
  expect(mocks.history).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toMatch(/private_payload|server-only/);
});

it.each(["overview", "rows"])(
  "allows Treg subfolder %s after its backlink dependencies are verified",
  async (kind) => {
    mocks.execution.mockResolvedValue({ provider: "treg", revision: 4 });
    const input = {
      target: "https://www.rkumar.in/collections/frame-montana",
      scope: "subfolder" as const,
    };
    const result =
      kind === "overview"
        ? await fetchBacklinksOverview(customer, input)
        : await fetchBacklinksPage(customer, {
            ...input,
            page: 1,
            pageSize: 10,
            sortField: "rank",
            sortOrder: "desc",
            filters: {},
            mode: "as_is",
          });
    expect(result).toMatchObject({
      ok: true,
      meta: { provider: "treg", scope: { researchScope: "subfolder" } },
    });
    if (kind === "overview")
      expect(result).toMatchObject({
        data: {
          overview: { summary: { backlinks: 2, rank: null }, trends: [] },
        },
      });
    else
      expect(result).toMatchObject({
        data: {
          rows: [{ rank: 0, urlFrom: "https://source.example/link" }],
          totalCount: 2,
        },
      });
  },
);
