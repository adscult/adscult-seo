import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { tregAdapter } from "./adapter";
import { withProviderExecution } from "../context";
import { fetchKeywordOverview } from "@/server/lib/dataforseo/labs";
import { fetchRankCheckSerp } from "@/server/lib/dataforseo/serp";
import { fetchSerpLocationsForCountry } from "@/server/lib/dataforseo/serp-locations";

vi.mock("cloudflare:workers", () => ({
  env: { KV: { get: async () => null, put: async () => undefined } },
}));

vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: async () => false,
  getOptionalEnvValue: async (name: string) =>
    name === "TREG_MAX_CALL_COST_USD" ? "0" : undefined,
}));
vi.mock("@/server/providers/task-context", () => ({
  resolveTaskExecution: async (_path: string, execution: unknown) => execution,
}));

const execution = {
  organizationId: "org-a",
  provider: "treg" as const,
  revision: 7,
  credentialVersion: "candidate",
  source: "database" as const,
  authorization: "private-token",
};
const path = "/v3/dataforseo_labs/google/keyword_overview/live";
const body = JSON.stringify([
  { keywords: ["coffee"], location_code: 2840, language_code: "en" },
]);
const request = vi.fn<typeof fetch>();
function response(costHeader: string | null = "1200", taskStatus = 20000) {
  return Response.json(
    {
      status_code: 20000,
      tasks: [
        {
          status_code: taskStatus,
          path: path.split("/").filter(Boolean),
          cost: 0.02412,
          result: [
            {
              items: [
                {
                  keyword: "coffee",
                  keyword_info: { search_volume: 0, cpc: null },
                },
              ],
            },
          ],
        },
      ],
    },
    {
      headers:
        costHeader === null
          ? {}
          : { "X-Treg-Cost-Micro": costHeader, "X-Treg-Call-Id": "receipt-1" },
    },
  );
}
beforeEach(() => {
  request.mockImplementation(async () => response());
  vi.stubGlobal("fetch", request);
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  ["1200", 0.0012],
  ["0", 0],
  [null, 0],
] as const)(
  "preserves parsed keyword metrics and uses Treg's charge %s rather than the native price",
  async (header, costUsd) => {
    request.mockImplementationOnce(async () => response(header));
    const result = await withProviderExecution(execution, () =>
      fetchKeywordOverview({
        keywords: ["coffee"],
        locationCode: 2840,
        languageCode: "en",
      }),
    );
    expect(result).toMatchObject({
      data: [
        { keyword: "coffee", keyword_info: { search_volume: 0, cpc: null } },
      ],
      billing: { costUsd },
    });
    const [url, init] = request.mock.calls[0];
    expect(url).toBe(
      "https://treg.to/call/dataforseo.x.dataforseo-labs-google-keyword-overview-live",
    );
    if (typeof init?.body !== "string") throw new Error("Expected JSON body");
    expect(JSON.parse(init.body)).toEqual([
      {
        keywords: ["coffee"],
        location_code: 2840,
        language_code: "en",
        include_clickstream_data: false,
      },
    ]);
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("X-Treg-Token")).toBe("private-token");
    expect(headers.get("X-Treg-Meta")).toBe("customer=org-a");
    expect(headers.get("X-Treg-Route-Max-Cost")).toBe("0");
    expect(headers.get("Idempotency-Key")).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain("private-token");
  },
);

it("maps country path parameters to catalog query parameters and preserves a free response", async () => {
  request.mockResolvedValueOnce(
    Response.json({
      status_code: 20000,
      tasks: [
        {
          status_code: 20000,
          result: [
            {
              location_code: 1,
              location_name: "Vaduz,Liechtenstein",
              location_type: "City",
            },
          ],
        },
      ],
    }),
  );
  const result = await withProviderExecution(execution, () =>
    fetchSerpLocationsForCountry("LI"),
  );
  expect(result).toMatchObject([
    {
      locationCode: 1,
      locationName: "Vaduz,Liechtenstein",
      locationType: "City",
    },
  ]);
  expect(request.mock.calls[0][0]).toBe(
    "https://treg.to/call/dataforseo.x.serp-google-locations-country?country=li",
  );
});

it("uses advanced SERP results and retains organic rank semantics through the existing rank checker", async () => {
  request.mockResolvedValueOnce(
    Response.json(
      {
        status_code: 20000,
        tasks: [
          {
            status_code: 20000,
            path: ["v3", "serp", "google", "organic", "live", "advanced"],
            cost: 0.002,
            result: [
              {
                items: [
                  {
                    type: "paid",
                    rank_absolute: 1,
                    rank_group: 1,
                    domain: "example.com",
                  },
                  {
                    type: "organic",
                    rank_absolute: 4,
                    rank_group: 2,
                    domain: "example.com",
                    url: "https://example.com/",
                  },
                ],
              },
            ],
          },
        ],
      },
      { headers: { "X-Treg-Cost-Micro": "2000" } },
    ),
  );
  const result = await withProviderExecution(execution, () =>
    fetchRankCheckSerp({
      keyword: "coffee",
      keywordId: "keyword-1",
      targetDomain: "example.com",
      locationCode: 2840,
      languageCode: "en",
      device: "mobile",
      depth: 10,
    }),
  );
  expect(result).toMatchObject({
    data: { position: 2, url: "https://example.com/" },
    billing: { costUsd: 0.002 },
  });
  expect(request.mock.calls[0][0]).toBe(
    "https://treg.to/call/dataforseo.x.serp-google-organic-live-advanced",
  );
});

it.each([
  [
    "https://evil.example/v3/backlinks/summary/live",
    "POST",
    body,
    "VALIDATION_ERROR",
  ],
  [
    "https://api.dataforseo.com/v3/backlinks/summary/live?token=secret",
    "POST",
    body,
    "VALIDATION_ERROR",
  ],
  [
    "https://api.dataforseo.com/v3/serp/google/organic/task_post",
    "POST",
    body,
    "SEO_PROVIDER_UNSUPPORTED",
  ],
  ["https://api.dataforseo.com" + path, "GET", undefined, "VALIDATION_ERROR"],
  ["https://api.dataforseo.com" + path, "POST", "[{},{}]", "VALIDATION_ERROR"],
  ["https://api.dataforseo.com" + path, "POST", "{}", "VALIDATION_ERROR"],
] as const)(
  "refuses an unsupported destination or request before dispatch: %s %s",
  async (url, method, invalidBody, code) => {
    await expect(
      tregAdapter.request(execution, url, { method, body: invalidBody }),
    ).rejects.toMatchObject({ code });
    expect(request).not.toHaveBeenCalled();
  },
);

it.each([
  [401, "SEO_PROVIDER_AUTH_FAILED"],
  [403, "SEO_PROVIDER_AUTH_FAILED"],
  [402, "SEO_PROVIDER_QUOTA_EXCEEDED"],
  [429, "RATE_LIMITED"],
  [422, "VALIDATION_ERROR"],
  [503, "UPSTREAM_UNAVAILABLE"],
  [302, "UPSTREAM_UNAVAILABLE"],
] as const)(
  "sanitizes HTTP %s and never retries or switches providers",
  async (status, code) => {
    request.mockResolvedValueOnce(
      Response.json(
        { balance: "private balance", topup_url: "private account" },
        { status },
      ),
    );
    const result = tregAdapter.request(
      execution,
      "https://api.dataforseo.com" + path,
      { method: "POST", body },
    );
    await expect(result).rejects.toMatchObject({ code });
    await expect(result).rejects.not.toHaveProperty("details.responseBody");
    expect(request).toHaveBeenCalledOnce();
  },
);

it("retains native HTTP-200 task failures and the actual charge for billing settlement", async () => {
  request.mockImplementationOnce(async () => response("100", 40501));
  await expect(
    withProviderExecution(execution, () =>
      fetchKeywordOverview({
        keywords: ["coffee"],
        locationCode: 2840,
        languageCode: "en",
      }),
    ),
  ).rejects.toMatchObject({
    name: "DataforseoChargedTaskError",
    billing: { costUsd: 0.0001 },
  });
  expect(request).toHaveBeenCalledOnce();
});

it.each(["-1", "0.5", "NaN", "9007199254740992"])(
  "rejects invalid metering header %s instead of silently treating it as free",
  async (header) => {
    request.mockImplementationOnce(async () => response(header));
    await expect(
      tregAdapter.request(execution, "https://api.dataforseo.com" + path, {
        method: "POST",
        body,
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  },
);

it("never replays a submission after a transport timeout", async () => {
  request.mockRejectedValueOnce(
    new DOMException("uncertain outcome", "TimeoutError"),
  );
  await expect(
    withProviderExecution(execution, () =>
      fetchKeywordOverview({
        keywords: ["coffee"],
        locationCode: 2840,
        languageCode: "en",
      }),
    ),
  ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  expect(request).toHaveBeenCalledOnce();
});

it("blocks an unverified route before it can spend", async () => {
  await expect(
    tregAdapter.request(
      execution,
      "https://api.dataforseo.com/v3/business_data/google/my_business_info/live",
      { method: "POST", body: JSON.stringify([{ target: "example.com" }]) },
    ),
  ).rejects.toMatchObject({ code: "SEO_PROVIDER_UNSUPPORTED" });
  expect(request).not.toHaveBeenCalled();
});
