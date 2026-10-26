import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverUrls } from "@/server/lib/audit/discovery";

function sitemapXml(urls: string[]): string {
  const entries = urls.map((url) => `<url><loc>${url}</loc></url>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><urlset>${entries}</urlset>`;
}

afterEach(() => vi.unstubAllGlobals());

it("retains robots directives within the byte limit when the rest of the body is oversized", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("robots.txt")
        ? new Response(
            "User-agent: *\nDisallow: /private\n#" + "x".repeat(600_000),
          )
        : new Response(sitemapXml(["https://example.com/public"])),
    ),
  );
  const result = await discoverUrls("https://example.com");
  expect(result.robotsText).toContain("Disallow: /private");
  expect(result.robotsText!.length).toBeLessThanOrEqual(500 * 1024);
});

it("includes collection pages before product shards exhaust a comparison's URL budget", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          url.endsWith("robots.txt")
            ? "Sitemap: https://example.com/sitemap.xml"
            : url.endsWith("sitemap.xml")
              ? "<sitemapindex><sitemap><loc>https://example.com/sitemap_products.xml</loc></sitemap><sitemap><loc>https://example.com/sitemap_collections.xml</loc></sitemap></sitemapindex>"
              : sitemapXml([
                  url.includes("products")
                    ? "https://example.com/products/frame"
                    : "https://example.com/collections/sunglasses",
                ]),
        ),
    ),
  );
  const result = await discoverUrls("https://example.com", 10, undefined, {
    maxUrls: 1,
    prioritizeContent: true,
  });
  expect(result).toMatchObject({
    urls: ["https://example.com/collections/sunglasses"],
    incomplete: true,
  });
});

it("reports incomplete sitemap coverage when the document limit leaves an index unread", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(
          url.endsWith("robots.txt")
            ? "Sitemap: https://example.com/sitemap.xml"
            : "<sitemapindex><sitemap><loc>https://example.com/child.xml</loc></sitemap></sitemapindex>",
        ),
    ),
  );
  const result = await discoverUrls("https://example.com", 10, undefined, {
    maxDocuments: 1,
  });
  expect(result).toMatchObject({ urls: [], incomplete: true });
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).not.toContain(
    "https://example.com/child.xml",
  );
});

it("does not fetch an off-site redirect when discovery is restricted to the compared origin", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://other.test/sitemap.xml" },
        }),
    ),
  );
  const result = await discoverUrls("https://example.com", 10, undefined, {
    restrictOrigin: "https://example.com",
  });
  expect(result).toMatchObject({ urls: [], incomplete: true });
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).not.toContain(
    "https://other.test/sitemap.xml",
  );
});

describe("discoverUrls", () => {
  // Seeding the frontier is what sets a page's in-sitemap flag, so a URL
  // dropped here reports inSitemap: false once the crawl reaches it through a
  // link. Real sitemaps bury the homepage in the middle of the list
  // (bannerbear.com lists it 387th of 1,328).
  it("returns sitemap URLs listed past the crawl's page budget", async () => {
    const posts = Array.from(
      { length: 5 },
      (_, index) => `https://example.com/blog/post-${index}/`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          url.endsWith("/robots.txt")
            ? new Response("User-agent: *\nAllow: /")
            : new Response(sitemapXml([...posts, "https://example.com/"]), {
                headers: { "content-type": "application/xml" },
              }),
        ),
      ),
    );

    const { urls } = await discoverUrls("https://example.com", 2);

    expect(urls).toContain("https://example.com/");
  });
});
