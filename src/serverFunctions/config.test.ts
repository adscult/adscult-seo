import { expect, it, vi } from "vitest";
import { getSeoApiKeyStatus } from "./config";

const { resolve } = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("@/server/providers/resolver", () => ({
  resolveProviderExecution: resolve,
}));
vi.mock("@/serverFunctions/middleware", () => ({
  requireAuthenticatedContext: [],
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    middleware: () => ({
      handler:
        (
          handler: (input: { context: { organizationId: string } }) => unknown,
        ) =>
        () =>
          handler({ context: { organizationId: "organization" } }),
    }),
  }),
}));

it.each(["dataforseo", "treg"])(
  "recognizes configured %s credentials without returning secrets",
  async (provider) => {
    resolve.mockResolvedValueOnce({ provider, authorization: "private-token" });
    expect(await getSeoApiKeyStatus()).toEqual({ configured: true, provider });
  },
);

it("reports unavailable configuration when credentials cannot be resolved", async () => {
  resolve.mockRejectedValueOnce(new Error("Missing credentials"));
  expect(await getSeoApiKeyStatus()).toEqual({
    configured: false,
    provider: null,
  });
});
