import { discoverUrls } from "@/server/lib/audit/discovery";
import {
  normalizeAndValidateStartUrl,
  resolveStartUrlRedirects,
} from "@/server/lib/audit/url-policy";
import { AppError } from "@/server/lib/errors";
import type { SitemapSite } from "@/types/schemas/page-gaps";

async function resolveOrigin(input: string) {
  const validated = await normalizeAndValidateStartUrl(input);
  const url = new URL(validated);
  if (
    url.username ||
    url.password ||
    url.port ||
    !["", "/"].includes(url.pathname) ||
    url.search
  )
    throw new AppError("VALIDATION_ERROR");
  const redirected = await resolveStartUrlRedirects(url.origin);
  return new URL(redirected.url).origin;
}

async function read(origin: string): Promise<SitemapSite & { urls: string[] }> {
  const result = await discoverUrls(origin, 250, undefined, {
    maxDocuments: 20,
    maxUrls: 5000,
    signal: AbortSignal.timeout(45_000),
    restrictOrigin: origin,
    prioritizeContent: true,
  });
  return {
    origin,
    urls: result.urls,
    pageCount: result.urls.length,
    status: !result.urls.length
      ? "unavailable"
      : result.incomplete
        ? "partial"
        : "available",
  };
}

export const SitemapRepository = { resolveOrigin, read };
