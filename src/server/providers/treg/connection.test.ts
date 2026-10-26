import { afterEach, expect, it, vi } from "vitest";
import { getProviderAdapter } from "../registry";

const execution = {
  organizationId: "org",
  provider: "treg" as const,
  revision: 7,
  credentialVersion: "version",
  source: "database" as const,
  authorization: "test-token",
};
const adapter = getProviderAdapter("treg");
afterEach(() => vi.unstubAllGlobals());

it("authenticates through the fixed free account route without returning account data or changing capabilities", async () => {
  const capabilities = adapter.capabilities();
  const request = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      org_id: 1,
      org: "test-team",
      email: "private@example.com",
      uploads: ["private-file"],
    }),
  );
  vi.stubGlobal("fetch", request);
  const result = await adapter.testConnection(execution);
  expect(result).toMatchObject({
    ok: true,
    data: { authenticated: true },
    meta: { provider: "treg", upstreamVendor: "treg", settingsRevision: 7 },
  });
  expect(JSON.stringify(result)).not.toMatch(
    /private@example|private-file|test-team|test-token/,
  );
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "https://treg.to/auth/me",
    expect.objectContaining({
      method: "GET",
      redirect: "manual",
      headers: { "X-Treg-Token": "test-token" },
    }),
  );
  expect(adapter.capabilities()).toEqual(capabilities);
  expect(request).toHaveBeenCalledOnce();
});

it.each([
  { status: 401, code: "AUTH_FAILED" },
  { status: 403, code: "AUTH_FAILED" },
  { status: 429, code: "RATE_LIMITED" },
  { status: 503, code: "UPSTREAM_ERROR" },
  { status: 302, code: "UPSTREAM_ERROR" },
])(
  "sanitizes HTTP $status as $code without retrying",
  async ({ status, code }) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ detail: "private account information" }, { status }),
      );
    vi.stubGlobal("fetch", request);
    const result = await adapter.testConnection(execution);
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(JSON.stringify(result)).not.toContain("private account information");
    expect(request).toHaveBeenCalledOnce();
  },
);

it.each(["not-json", JSON.stringify({})])(
  "rejects an invalid account response: %s",
  async (body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(body)),
    );
    expect(await adapter.testConnection(execution)).toMatchObject({
      ok: false,
      error: { code: "INVALID_RESPONSE" },
    });
  },
);

it("reports an account timeout without retrying", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new DOMException("timeout", "TimeoutError"));
  vi.stubGlobal("fetch", request);
  expect(await adapter.testConnection(execution)).toMatchObject({
    ok: false,
    error: { code: "TIMEOUT", retryable: true },
  });
  expect(request).toHaveBeenCalledOnce();
});
