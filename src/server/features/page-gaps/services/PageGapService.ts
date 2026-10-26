import { sort } from "remeda";
import { SitemapRepository } from "../repositories/SitemapRepository";
import { AppError } from "@/server/lib/errors";
import type {
  PageGap,
  PageGapComparison,
  SitemapSite,
} from "@/types/schemas/page-gaps";

const ignored =
  /^(cart|checkout|account|login|search|tag|tags|privacy|privacy-policy|terms|terms-of-service|shipping|returns|contact|contact-us|about|about-us)$/;
const containers =
  /^(collections?|categor(?:y|ies)|products?|services?|blogs?|articles?|pages?|brands?|en|en-[a-z]{2})$/;
const stopWords = /^(the|a|an|and|for|of|in|buy|shop|online)$/;

function describe(url: string) {
  const path = new URL(url).pathname;
  let segments: string[];
  try {
    segments = decodeURIComponent(path)
      .toLowerCase()
      .split("/")
      .filter(Boolean);
  } catch {
    return null;
  }
  if (!segments.length || segments.some((s) => ignored.test(s))) return null;
  const leaf = segments.at(-1)!.replace(/\.(html?|aspx|php)$/, "");
  if (containers.test(leaf)) return null;
  const tokens = [
    ...new Set(
      leaf.split(/[^\p{L}\p{N}]+/u).filter((s) => s && !stopWords.test(s)),
    ),
  ];
  if (!tokens.length || tokens.every((token) => /^\d+$/.test(token)))
    return null;
  const kind: PageGap["kind"] = segments.some((s) => /^products?$/.test(s))
    ? "Product"
    : segments.some((s) => /^(collections?|categor(?:y|ies)|brands?)$/.test(s))
      ? "Category"
      : segments.some((s) => /^(blogs?|articles?|guides?|resources?)$/.test(s))
        ? "Content"
        : segments.some((s) => /^services?$/.test(s))
          ? "Service"
          : "Other";
  return {
    key: `${kind}:${sort(tokens, (a, b) => a.localeCompare(b)).join(" ")}`,
    topic: tokens.join(" "),
    tokens,
    kind,
    path,
  };
}

type Inventory = SitemapSite & { urls: string[] };

function compare(
  ownSite: Inventory,
  rivals: Inventory[],
): Omit<PageGapComparison, "checkedAt"> {
  const { urls: ownUrls, ...website } = ownSite;
  const competitors = rivals.map(({ origin, status, pageCount }) => ({
    origin,
    status,
    pageCount,
  }));
  // Absence cannot be inferred when the site's own sitemap was not readable.
  if (website.status === "unavailable")
    return { website, competitors, gaps: [], coveredTopics: 0, totalGaps: 0 };
  const own = ownUrls.flatMap((url) => {
    const page = describe(url);
    return page ? [{ ...page, url }] : [];
  });
  const ownByKey = new Map(own.map((page) => [page.key, page]));
  const byToken = new Map<string, typeof own>();
  for (const page of own)
    for (const token of page.tokens) {
      const pages = byToken.get(token) ?? [];
      if (pages.length < 100) pages.push(page);
      byToken.set(token, pages);
    }
  const prefixes = new Map<PageGap["kind"], string>();
  for (const page of own)
    if (!prefixes.has(page.kind))
      prefixes.set(page.kind, page.path.split("/").slice(0, -1).join("/"));
  const topics = new Map<string, PageGap>();
  const covered = new Set<string>();
  for (const site of rivals) {
    for (const url of site.urls) {
      const page = describe(url);
      if (!page) continue;
      if (ownByKey.has(page.key)) {
        covered.add(page.key);
        continue;
      }
      let gap = topics.get(page.key);
      if (!gap) {
        // Token overlap is only a review aid, never proof that a page is missing.
        const candidates = [
          ...new Set(page.tokens.flatMap((token) => byToken.get(token) ?? [])),
        ];
        const related = sort(
          candidates
            .map((candidate) => ({
              candidate,
              score:
                page.tokens.filter((token) => candidate.tokens.includes(token))
                  .length /
                Math.max(page.tokens.length, candidate.tokens.length),
            }))
            .filter((match) => match.score >= 0.5),
          (a, b) => b.score - a.score,
        )[0];
        const prefix =
          prefixes.get(page.kind) ??
          page.path.split("/").slice(0, -1).join("/");
        gap = {
          topic: page.topic,
          kind: page.kind,
          suggestedPath: `${prefix}/${page.tokens.map(encodeURIComponent).join("-")}`,
          competitors: [],
          similarPage: related?.candidate.url ?? null,
        };
        topics.set(page.key, gap);
      }
      if (!gap.competitors.some((entry) => entry.origin === site.origin))
        gap.competitors.push({ origin: site.origin, url });
    }
  }
  const gaps = sort(
    [...topics.values()],
    (a, b) =>
      Number(a.kind === "Product") - Number(b.kind === "Product") ||
      b.competitors.length - a.competitors.length ||
      Number(!!a.similarPage) - Number(!!b.similarPage) ||
      a.topic.localeCompare(b.topic),
  );
  return {
    website,
    competitors,
    gaps: gaps.slice(0, 200),
    coveredTopics: covered.size,
    totalGaps: gaps.length,
  };
}

async function compareSitemaps(input: {
  website: string;
  competitors: string[];
}): Promise<PageGapComparison> {
  const [origin, ...origins] = await Promise.all(
    [input.website, ...input.competitors].map((site) =>
      SitemapRepository.resolveOrigin(site),
    ),
  );
  const rivals = [...new Set(origins)].filter(
    (site) =>
      site.replace("://www.", "://") !== origin.replace("://www.", "://"),
  );
  if (!rivals.length) throw new AppError("VALIDATION_ERROR");
  const [website, ...competitors] = await Promise.all(
    [origin, ...rivals].map((site) => SitemapRepository.read(site)),
  );
  return {
    ...compare(website, competitors),
    checkedAt: new Date().toISOString(),
  };
}

export const PageGapService = { compareSitemaps };
