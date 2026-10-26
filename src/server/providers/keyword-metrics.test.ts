import { beforeEach, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";
import { fetchKeywordMetrics } from "./keyword-metrics";
import { withProviderExecution } from "./context";

const { overview } = vi.hoisted(() => ({ overview: vi.fn() }));
vi.mock("@/server/providers/resolver", () => ({
  resolveProviderExecution: async () => ({
    organizationId: "organization",
    provider: "dataforseo",
    revision: 2,
    credentialVersion: "configuration",
    source: "database",
    authorization: "server-only-secret",
  }),
}));
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: () => ({ labs: { keywordOverview: overview } }),
}));

beforeEach(() => {
  overview.mockResolvedValue([]);
});

it("refuses unverified local volume before purchasing the national metrics leg", async () => {
  const customer = {
    organizationId: "organization",
    userId: "user",
    userEmail: "user@example.com",
  };
  const result = await withProviderExecution(
    {
      ...customer,
      provider: "treg",
      revision: 2,
      credentialVersion: "configuration",
      source: "database",
      authorization: "server-only",
    },
    () =>
      fetchKeywordMetrics(customer, {
        keywords: ["coffee"],
        locationCode: 2356,
        locationName: "Mumbai,Maharashtra,India",
        languageCode: "en",
        creditFeature: "keyword_research",
      }),
  );
  expect(result).toMatchObject({ ok: false, error: { code: "UNSUPPORTED" } });
  expect(overview).not.toHaveBeenCalled();
});

it("isolates malformed metric values from other keywords in the same response", async () => {
  overview.mockResolvedValueOnce([
    { keyword: "coffee", keyword_info: { search_volume: "unavailable" } },
    { keyword: "tea", keyword_info: { search_volume: 0 } },
  ]);
  const result = await fetchKeywordMetrics(
    {
      organizationId: "organization",
      userId: "user",
      userEmail: "user@example.com",
    },
    {
      keywords: ["coffee", "tea"],
      locationCode: 2840,
      languageCode: "en",
      creditFeature: "keyword_research",
    },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected the valid keyword to survive");
  expect(result.data.items[0].result).toMatchObject({
    ok: false,
    error: { code: "INVALID_RESPONSE" },
  });
  expect(result.data.items[1].result).toMatchObject({
    ok: true,
    data: { searchVolume: 0 },
  });
});

it.each([
  ["DATAFORSEO_AUTH_FAILED", "AUTH_FAILED", "AppError"],
  ["SEO_PROVIDER_QUOTA_EXCEEDED", "QUOTA_EXCEEDED", "AppError"],
  ["UPSTREAM_UNAVAILABLE", "TIMEOUT", "DataForSEOTimeoutError"],
] as const)(
  "reports %s as %s rather than an empty result",
  async (code, category, name) => {
    const error = new AppError(code);
    error.name = name;
    overview.mockRejectedValueOnce(error);
    const result = await fetchKeywordMetrics(
      {
        organizationId: "organization",
        userId: "user",
        userEmail: "user@example.com",
      },
      {
        keywords: ["coffee"],
        locationCode: 2840,
        languageCode: "en",
        creditFeature: "keyword_research",
      },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: category, retryable: false },
    });
  },
);

it("preserves successful keyword batches, identifies failed inputs and never replays the failed submission", async () => {
  overview
    .mockResolvedValueOnce([
      { keyword: "coffee", keyword_info: { search_volume: 50 } },
    ])
    .mockRejectedValueOnce(
      new AppError("UPSTREAM_UNAVAILABLE", "raw vendor payload"),
    )
    .mockResolvedValueOnce([
      { keyword: "last", keyword_info: { search_volume: 0 } },
    ]);
  const keywords = Array.from(
    { length: 1401 },
    (_, index) => `keyword ${index}`,
  );
  keywords[0] = "Coffee";
  keywords[1] = "Coffee";
  keywords[1400] = "last";
  const result = await fetchKeywordMetrics(
    {
      organizationId: "organization",
      userId: "user",
      userEmail: "user@example.com",
    },
    {
      keywords,
      locationCode: 2840,
      languageCode: "en",
      creditFeature: "keyword_research",
    },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected a partial batch result");
  expect(
    result.data.items.map(({ inputIndex, keyword }) => [inputIndex, keyword]),
  ).toEqual(keywords.map((keyword, index) => [index, keyword]));
  expect(result.data.items[0].result).toMatchObject({
    ok: true,
    data: { searchVolume: 50 },
  });
  expect(result.data.items[1].result).toMatchObject({
    ok: true,
    data: { searchVolume: 50 },
  });
  expect(result.data.items[2].result).toMatchObject({
    ok: true,
    data: { searchVolume: null },
  });
  expect(result.data.items[700].result).toMatchObject({
    ok: false,
    error: { code: "UPSTREAM_ERROR", retryable: false },
  });
  expect(result.data.items[1400].result).toMatchObject({
    ok: true,
    data: { searchVolume: 0 },
  });
  expect(result.meta.warnings).toEqual([
    "Metrics unavailable for 700 of 1401 inputs.",
  ]);
  expect(JSON.stringify(result)).not.toMatch(
    /raw vendor payload|server-only-secret/,
  );
  expect(overview).toHaveBeenCalledTimes(3);
});
