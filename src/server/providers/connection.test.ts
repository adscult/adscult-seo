import { afterEach, describe, expect, it, vi } from "vitest";
import { getProviderAdapter } from "./registry";

const execution = {
  organizationId: "org",
  provider: "dataforseo" as const,
  revision: 7,
  credentialVersion: "credential-version",
  source: "database" as const,
  authorization: btoa("login:password"),
};

afterEach(() => vi.unstubAllGlobals());

describe("provider connection contract", () => {
  it.each(["dataforseo", "treg"] as const)(
    "authenticates %s with Worker-compatible redirect handling",
    async (provider) => {
      const request = vi
        .fn<typeof fetch>()
        .mockImplementation(async (_url, init) => {
          // The local workerd runtime rejects this mode before any HTTP call.
          if (init?.redirect === "error")
            throw new TypeError("Unsupported redirect mode");
          return Response.json(
            provider === "dataforseo"
              ? {
                  status_code: 20000,
                  tasks: [{ status_code: 20000, result: [{}] }],
                }
              : { org_id: 1, org: "test-team" },
          );
        });
      vi.stubGlobal("fetch", request);
      expect(
        await getProviderAdapter(provider).testConnection({
          ...execution,
          provider,
        }),
      ).toMatchObject({ ok: true, data: { authenticated: true } });
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { http: 401, vendor: 20000, code: "AUTH_FAILED" },
    { http: 402, vendor: 20000, code: "QUOTA_EXCEEDED" },
    { http: 429, vendor: 20000, code: "RATE_LIMITED" },
    { http: 503, vendor: 20000, code: "UPSTREAM_ERROR" },
    { http: 200, vendor: 40100, code: "AUTH_FAILED" },
    { http: 200, vendor: 40210, code: "QUOTA_EXCEEDED" },
    { http: 200, vendor: 40202, code: "RATE_LIMITED" },
  ])(
    "classifies HTTP $http / task $vendor as $code without retrying",
    async ({ http, vendor, code }) => {
      const request = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          {
            status_code: 20000,
            tasks: [{ status_code: vendor, result: [{}] }],
          },
          { status: http },
        ),
      );
      vi.stubGlobal("fetch", request);
      expect(
        await getProviderAdapter("dataforseo").testConnection(execution),
      ).toMatchObject({
        ok: false,
        error: { code },
        meta: { provider: "dataforseo", settingsRevision: 7 },
      });
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it("reports timeouts without a second account request", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new DOMException("timeout", "TimeoutError"));
    vi.stubGlobal("fetch", request);
    expect(
      await getProviderAdapter("dataforseo").testConnection(execution),
    ).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects an invalid JSON body as a response error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("not-json")),
    );
    expect(
      await getProviderAdapter("dataforseo").testConnection(execution),
    ).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
  });

  it("does not send credentials to a redirect destination", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: "https://untrusted.example/" },
      }),
    );
    vi.stubGlobal("fetch", request);
    expect(
      await getProviderAdapter("dataforseo").testConnection(execution),
    ).toMatchObject({ ok: false });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "https://api.dataforseo.com/v3/appendix/user_data",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("rejects unknown provider IDs without selecting a default", () => {
    expect(() => getProviderAdapter("unknown")).toThrowError(
      "SEO_PROVIDER_NOT_CONFIGURED",
    );
  });
});
