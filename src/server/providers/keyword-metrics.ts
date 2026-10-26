import { normalizeProviderFailure } from "./operation";
import { z } from "zod";
import { assertLanguageForLocation } from "@/server/lib/market";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { fetchKeywordMetricsForList } from "@/server/lib/dataforseo/keyword-metrics";
import { AppError } from "@/server/lib/errors";
import { getScopedProviderExecution, withProviderScope } from "./context";
import { getProviderAdapter } from "./registry";
import { getKeywordDataProvider } from "@/shared/keyword-locations";
import type {
  ProviderResult,
  KeywordMetricRow,
  KeywordMetricsRequest,
} from "./types";

const keywordMetricSchema = z.object({
  keyword: z.string(),
  searchVolume: z.number().int().nonnegative().nullable(),
  cpc: z.number().nonnegative().nullable(),
  competition: z.number().min(0).max(1).nullable(),
  competitionLevel: z.string().nullable(),
  keywordDifficulty: z.number().min(0).max(100).nullable(),
  intent: z.string().nullable(),
  monthlySearches: z.array(
    z.object({
      year: z.number().int().positive(),
      month: z.number().int().min(1).max(12),
      searchVolume: z.number().int().nonnegative().nullable(),
    }),
  ),
});
type KeywordMetricsBatch = {
  scope: {
    locationCode: number;
    locationName: string | null;
    languageCode: string;
    cpcCurrency: "USD";
    competitionScale: "0-1";
    volumeUnit: "monthly_searches";
  };
  items: Array<{
    inputIndex: number;
    keyword: string;
    result: ProviderResult<KeywordMetricRow>;
  }>;
};

// Keep the existing paid client and its reservation/settlement behavior inside
// the adapter boundary. Failed batches are reported without replaying submissions.
export function fetchKeywordMetrics(
  customer: BillingCustomerContext,
  params: KeywordMetricsRequest,
): Promise<ProviderResult<KeywordMetricsBatch>> {
  assertLanguageForLocation(params.locationCode, params.languageCode);
  return withProviderScope(
    customer.organizationId,
    async (): Promise<ProviderResult<KeywordMetricsBatch>> => {
      const execution = await getScopedProviderExecution();
      if (!execution) throw new AppError("SEO_PROVIDER_NOT_CONFIGURED");
      const meta = {
        provider: execution.provider,
        upstreamVendor: "dataforseo",
        operation: "keywords.metrics",
        settingsRevision: execution.revision,
        fetchedAt: new Date().toISOString(),
        warnings: [] as string[],
      };
      const usesAds =
        getKeywordDataProvider(params.locationCode) === "google_ads";
      const required = [
        ...(!usesAds ? ["keywords.overview"] : []),
        ...(usesAds || params.locationName ? ["keywords.adsVolume"] : []),
      ];
      const capabilities = getProviderAdapter(
        execution.provider,
      ).capabilities();
      if (
        !required.every((operation) =>
          capabilities.some(
            (capability) =>
              capability.operation === operation &&
              capability.state === "available",
          ),
        )
      ) {
        return {
          ok: false,
          error: {
            code: "UNSUPPORTED",
            message: "SEO_PROVIDER_UNSUPPORTED",
            retryable: false,
          },
          meta,
        };
      }
      const client = createDataforseoClient(customer);
      const items: KeywordMetricsBatch["items"] = [];
      for (let offset = 0; offset < params.keywords.length; offset += 700) {
        const keywords = params.keywords.slice(offset, offset + 700);
        try {
          const metrics = await fetchKeywordMetricsForList(client, {
            ...params,
            keywords,
          });
          metrics.forEach((metric, index) => {
            const parsed = keywordMetricSchema.safeParse(metric);
            items.push({
              inputIndex: offset + index,
              keyword: keywords[index],
              result: parsed.success
                ? { ok: true, data: parsed.data, meta }
                : {
                    ok: false,
                    error: {
                      code: "INVALID_RESPONSE",
                      message: "UPSTREAM_UNAVAILABLE",
                      retryable: false,
                    },
                    meta,
                  },
            });
          });
        } catch (cause) {
          const error = normalizeProviderFailure(cause);
          for (const [index, keyword] of keywords.entries()) {
            items.push({
              inputIndex: offset + index,
              keyword,
              result: { ok: false, error, meta },
            });
          }
        }
      }
      const failed = items.filter((item) => !item.result.ok).length;
      if (failed)
        meta.warnings.push(
          `Metrics unavailable for ${failed} of ${items.length} inputs.`,
        );
      if (items.length > 0 && failed === items.length) {
        const first = items[0].result;
        if (!first.ok) return { ok: false, error: first.error, meta };
      }
      return {
        ok: true,
        data: {
          scope: {
            locationCode: params.locationCode,
            locationName: params.locationName ?? null,
            languageCode: params.languageCode,
            cpcCurrency: "USD",
            competitionScale: "0-1",
            volumeUnit: "monthly_searches",
          },
          items,
        },
        meta,
      };
    },
  );
}
