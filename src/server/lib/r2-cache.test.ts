import { expect, it, vi } from "vitest";
import { buildCacheKey } from "./r2-cache";
import { withProviderScope } from "@/server/providers/context";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/providers/resolver", () => ({
  resolveProviderExecution: () => {
    throw new Error("No SEO credentials configured");
  },
}));

it("keeps native audit and Search Console cache keys usable without SEO credentials", async () => {
  const key = await withProviderScope("org", () =>
    buildCacheKey(
      "dashboard:first-audit",
      { organizationId: "org" },
      { seoProvider: false },
    ),
  );
  expect(key).toMatch(/^dashboard:first-audit:/);
});
