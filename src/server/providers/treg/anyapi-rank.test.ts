import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchRankChecks } from "../rank-check";
import { withProviderExecution } from "../context";

const mocks = vi.hoisted(() => ({
  native: vi.fn(),
  request: vi.fn<typeof fetch>(),
}));
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: () => ({ serp: { rankCheckBatch: mocks.native } }),
  fetchRankCheckTaskResult: vi.fn(),
}));
vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: async () => false,
  getOptionalEnvValue: async () => "0.01",
}));
const execution = {
  organizationId: "org",
  provider: "treg" as const,
  revision: 3,
  credentialVersion: "retained",
  source: "database" as const,
  authorization: "private-token",
};
const customer = {
  organizationId: "org",
  userId: "user",
  userEmail: "user@example.com",
};
const input = {
  keywordId: "kw",
  keyword: "coffee",
  device: "provider" as const,
  locationCode: 2356,
  languageCode: "en",
  targetDomain: "example.com",
  depth: 20,
};
function page(
  results: { link: string; position: number }[],
  nextCursor?: string,
) {
  return Response.json(
    { output: { found: true, data: { results, nextCursor } } },
    { headers: { "X-Treg-Cost-Micro": "400", "X-Treg-Call-Id": "receipt" } },
  );
}
beforeEach(() => {
  mocks.request.mockImplementation(async () => page([]));
  vi.stubGlobal("fetch", mocks.request);
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  { cursor: undefined, position: 18 },
  { cursor: "legacy-cursor", position: 8 },
])(
  "preserves rank 18 for numbered page response %j",
  async ({ cursor, position }) => {
    mocks.request
      .mockResolvedValueOnce(
        page(
          [
            { link: "https://other.com", position: 1 },
            { link: "https://example.com.evil.com", position: 2 },
          ],
          cursor,
        ),
      )
      .mockResolvedValueOnce(
        page([{ link: "https://shop.example.com/ranked", position }]),
      );
    const result = await withProviderExecution(execution, () =>
      fetchRankChecks(customer, [input], "anyapi"),
    );
    expect(result).toMatchObject({
      ok: true,
      meta: { provider: "treg", upstreamVendor: "anyapi", settingsRevision: 3 },
      data: {
        items: [
          {
            device: "provider",
            result: {
              ok: true,
              data: { position: 18, url: "https://shop.example.com/ranked" },
            },
          },
        ],
      },
    });
    expect(mocks.native).not.toHaveBeenCalled();
    expect(mocks.request).toHaveBeenCalledTimes(2);
    const [url, init] = mocks.request.mock.calls[1];
    expect(url).toBe("https://treg.to/call/anyapi.google.serp.organic");
    if (typeof init?.body !== "string")
      throw new Error("Expected a JSON request body");
    expect(JSON.parse(init.body)).toEqual({
      query: "coffee",
      gl: "in",
      hl: "en",
      autocorrect: true,
      limit: 10,
      page: 2,
    });
    const headers = new Headers(init.headers);
    expect(headers.get("X-Treg-Route-Max-Cost")).toBe("0.002");
    expect(headers.get("X-Treg-Meta")).toBe("customer=org");
  },
);

it.each([
  { device: "mobile" as const },
  { locationName: "Mumbai,Maharashtra,India" },
  { locationCode: 999999 },
])(
  "rejects unsupported AnyAPI targeting before a purchase: %j",
  async (overrides) => {
    const result = await withProviderExecution(execution, () =>
      fetchRankChecks(customer, [{ ...input, ...overrides }], "anyapi"),
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        items: [{ result: { ok: false, error: { code: "INVALID_REQUEST" } } }],
      },
    });
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.native).not.toHaveBeenCalled();
  },
);

it("leaves a failed AnyAPI lookup unchecked without buying a DataForSEO fallback", async () => {
  mocks.request.mockResolvedValueOnce(
    new Response("private balance payload", { status: 402 }),
  );
  const result = await withProviderExecution(execution, () =>
    fetchRankChecks(customer, [input], "anyapi"),
  );
  expect(result).toMatchObject({
    ok: true,
    data: {
      items: [{ result: { ok: false, error: { code: "QUOTA_EXCEEDED" } } }],
    },
  });
  expect(mocks.request).toHaveBeenCalledOnce();
  expect(mocks.native).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toMatch(/private balance|private-token/);
});

it("checks each requested page without compressing sparse pages into ranks", async () => {
  mocks.request.mockResolvedValueOnce(
    page([{ link: "https://other.com", position: 9 }]),
  );
  mocks.request.mockResolvedValueOnce(
    page([{ link: "https://other.com", position: 20 }]),
  );
  const result = await withProviderExecution(execution, () =>
    fetchRankChecks(customer, [input], "anyapi"),
  );
  expect(result).toMatchObject({
    ok: true,
    data: {
      items: [{ result: { ok: true, data: { position: null, url: null } } }],
    },
  });
  expect(mocks.request).toHaveBeenCalledTimes(2);
  expect(mocks.native).not.toHaveBeenCalled();
});
