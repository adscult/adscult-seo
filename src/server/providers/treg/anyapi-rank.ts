import { z } from "zod";
import { sort } from "remeda";
import { AppError } from "@/server/lib/errors";
import {
  getIsoCountryCode,
  LOCATION_OPTIONS,
} from "@/shared/keyword-locations";
import type {
  RankCheckRequest,
  RankCheckResult,
} from "../contracts/rank-check";
import type { ProviderExecution } from "../types";
import {
  anyapiRankMaxPages,
  ANYAPI_MAX_PAGE_COST_USD,
} from "@/shared/rank-tracking";
import { callTregEndpoint } from "./call";

const outputSchema = z.object({
  output: z.discriminatedUnion("found", [
    z.object({
      found: z.literal(true),
      data: z.object({
        results: z.array(
          z.object({
            link: z.url({ protocol: /^https?$/ }),
            position: z.number().int().min(1).max(100),
          }),
        ),
      }),
    }),
    z.object({
      found: z.literal(false),
      data: z.null(),
      reason: z.literal("not_found"),
    }),
  ]),
});

/** Country-level organic ranks; AnyAPI does not expose a device selector. */
export async function fetchAnyapiRank(
  execution: ProviderExecution,
  input: RankCheckRequest,
): Promise<RankCheckResult> {
  if (
    input.device !== "provider" ||
    input.locationName ||
    !LOCATION_OPTIONS.some(
      (location) => location.code === input.locationCode,
    ) ||
    !/^[a-z]{2}$/.test(input.languageCode) ||
    !Number.isInteger(input.depth) ||
    input.depth < 10 ||
    input.depth > 100
  )
    throw new AppError("VALIDATION_ERROR");
  const signal = AbortSignal.timeout(300_000);
  const target = input.targetDomain.toLowerCase().replace(/^www\./, "");
  let hasOrganic = false;
  for (let page = 1; page <= anyapiRankMaxPages(input.depth); page++) {
    const { response } = await callTregEndpoint(
      execution,
      "anyapi.google.serp.organic",
      {
        body: {
          query: input.keyword,
          gl: getIsoCountryCode(input.locationCode),
          hl: input.languageCode,
          autocorrect: true,
          limit: 10,
          page,
        },
        maxCostUsd: ANYAPI_MAX_PAGE_COST_USD,
        signal,
      },
    );
    const { output } = outputSchema.parse(await response.json());
    if (!output.found) return result(null, null);
    const rows = sort(output.data.results, (a, b) => a.position - b.position);
    if (!rows.length) return result(null, null);
    hasOrganic = true;
    const pageOffset = (page - 1) * 10;
    // Sources can return absolute ranks (11..20 on page 2) or page-relative
    // ranks (1..10). Preserve gaps; missing rows do not move later results up.
    const relative = rows.every((item) => item.position <= 10);
    const ranked = rows.map((item) => ({
      ...item,
      position: item.position + (relative ? pageOffset : 0),
    }));
    if (
      ranked.some(
        (item) =>
          item.position <= pageOffset || item.position > pageOffset + 10,
      )
    )
      throw new AppError("UPSTREAM_UNAVAILABLE");
    for (const item of ranked) {
      if (item.position > input.depth) break;
      const host = new URL(item.link).hostname.toLowerCase();
      if (host === target || host.endsWith(`.${target}`))
        return result(item.position, item.link);
    }
  }
  return result(null, null);

  function result(
    position: number | null,
    url: string | null,
  ): RankCheckResult {
    return {
      keywordId: input.keywordId,
      keyword: input.keyword,
      position,
      url,
      serpFeatures: hasOrganic ? ["organic"] : [],
    };
  }
}
