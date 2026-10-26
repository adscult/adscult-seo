import { beforeEach, expect, it, vi } from "vitest";
import { PageGapService } from "./PageGapService";
import { SitemapRepository } from "../repositories/SitemapRepository";

vi.mock("../repositories/SitemapRepository", () => ({
  SitemapRepository: { resolveOrigin: vi.fn(), read: vi.fn() },
}));

const inventory = (
  origin: string,
  paths: string[],
  status: "available" | "partial" | "unavailable" = "available",
) => ({
  origin,
  urls: paths.map((path) => origin + path),
  pageCount: paths.length,
  status,
});
beforeEach(() => {
  vi.mocked(SitemapRepository.resolveOrigin).mockImplementation(
    async (input) => `https://${input}`,
  );
  vi.mocked(SitemapRepository.read).mockImplementation(async (origin) =>
    inventory(origin, []),
  );
});

it("groups shared competitor topics, excludes covered URLs and keeps near matches for review", async () => {
  vi.mocked(SitemapRepository.read).mockImplementation(async (origin) =>
    origin.includes("own.test")
      ? inventory(origin, [
          "/collections/prada",
          "/collections/mens-sunglasses",
        ])
      : inventory(origin, [
          "/category/prada?sort=price",
          "/collections/polarized-sunglasses",
          "/collections/polarized-sunglasses?sort=price",
          "/collections/sunglasses-for-men",
          "/cart",
        ]),
  );
  const result = await PageGapService.compareSitemaps({
    website: "own.test",
    competitors: ["one.test", "two.test", "one.test"],
  });
  expect(result.coveredTopics).toBe(1);
  expect(result.totalGaps).toBe(2);
  expect(
    result.gaps.find((gap) => gap.topic === "polarized sunglasses"),
  ).toMatchObject({
    suggestedPath: "/collections/polarized-sunglasses",
    competitors: [
      { origin: "https://one.test" },
      { origin: "https://two.test" },
    ],
    similarPage: "https://own.test/collections/mens-sunglasses",
  });
  expect(result.website).not.toHaveProperty("urls");
});

it("does not infer missing pages from an unavailable own sitemap", async () => {
  vi.mocked(SitemapRepository.read).mockImplementation(async (origin) =>
    origin.includes("own.test")
      ? inventory(origin, [], "unavailable")
      : inventory(origin, ["/services/seo"]),
  );
  const result = await PageGapService.compareSitemaps({
    website: "own.test",
    competitors: ["one.test"],
  });
  expect(result).toMatchObject({
    website: { status: "unavailable" },
    gaps: [],
    totalGaps: 0,
  });
});

it("keeps price thresholds and model numbers distinct in suggested topics", async () => {
  vi.mocked(SitemapRepository.read).mockImplementation(async (origin) =>
    inventory(
      origin,
      origin.includes("own.test")
        ? ["/collections/sunglasses-under-5000"]
        : ["/collections/sunglasses-under-10000"],
    ),
  );
  const result = await PageGapService.compareSitemaps({
    website: "own.test",
    competitors: ["one.test"],
  });
  expect(result.gaps).toMatchObject([
    {
      topic: "sunglasses under 10000",
      suggestedPath: "/collections/sunglasses-under-10000",
    },
  ]);
  expect(result.coveredTopics).toBe(0);
});

it("keeps page intent distinct and reports partial coverage without treating unavailable competitors as evidence", async () => {
  vi.mocked(SitemapRepository.read).mockImplementation(async (origin) =>
    origin.includes("own.test")
      ? inventory(origin, ["/collections/sunglasses"], "partial")
      : origin.includes("one.test")
        ? inventory(origin, ["/blog/sunglasses"])
        : inventory(origin, [], "unavailable"),
  );
  const result = await PageGapService.compareSitemaps({
    website: "own.test",
    competitors: ["one.test", "two.test"],
  });
  expect(result.website.status).toBe("partial");
  expect(result.gaps).toMatchObject([
    {
      kind: "Content",
      topic: "sunglasses",
      competitors: [{ origin: "https://one.test" }],
      similarPage: "https://own.test/collections/sunglasses",
    },
  ]);
  expect(result.coveredTopics).toBe(0);
});

it("rejects comparing a website with only itself before reading sitemaps", async () => {
  await expect(
    PageGapService.compareSitemaps({
      website: "own.test",
      competitors: ["www.own.test"],
    }),
  ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  expect(SitemapRepository.read).not.toHaveBeenCalled();
});
