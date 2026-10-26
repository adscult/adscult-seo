import type { CreditFeature } from "@/shared/billing-credit-features";
import type { MonthlySearch } from "@/types/keywords";
import type { SeoProviderId } from "@/types/schemas/seo-provider";

export type CapabilityState = "available" | "unsupported" | "unverified";
type ProviderErrorCode =
  | "UNSUPPORTED"
  | "NOT_CONFIGURED"
  | "INVALID_REQUEST"
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "QUOTA_EXCEEDED"
  | "TIMEOUT"
  | "UPSTREAM_ERROR"
  | "INVALID_RESPONSE"
  | "INSUFFICIENT_CREDITS";

interface ResultMeta {
  provider: SeoProviderId;
  upstreamVendor: string;
  operation: string;
  settingsRevision: number;
  fetchedAt: string;
  warnings: string[];
  scope?: {
    target: string;
    researchScope: string;
    includeSubdomains?: boolean;
  };
  metricDefinitions?: Record<string, string>;
}

export type ProviderResult<T> =
  | { ok: true; data: T; meta: ResultMeta }
  | {
      ok: false;
      error: { code: ProviderErrorCode; message: string; retryable: boolean };
      meta: ResultMeta;
    };

// Explicit inventory, rather than treating discovery/metrics or live/queued
// operations as interchangeable. Each adapter reports its verified coverage.
export const providerOperations = [
  { operation: "serp.live", label: "Live Google search results" },
  { operation: "serp.rankCheck", label: "Live rank checks" },
  { operation: "serp.rankTaskPost", label: "Queue rank checks" },
  { operation: "serp.rankTaskGet", label: "Collect queued rank checks" },
  { operation: "serp.local", label: "Live Google Maps results" },
  { operation: "serp.localTaskPost", label: "Queue Maps searches" },
  { operation: "serp.localTaskGet", label: "Collect queued Maps searches" },
  { operation: "serp.locations", label: "Search locations" },
  { operation: "keywords.related", label: "Related keywords" },
  { operation: "keywords.suggestions", label: "Keyword suggestions" },
  { operation: "keywords.ideas", label: "Keyword ideas" },
  { operation: "keywords.overview", label: "Keyword metrics (Labs)" },
  { operation: "keywords.adsIdeas", label: "Keyword ideas (Google Ads)" },
  { operation: "keywords.adsVolume", label: "Search volume (Google Ads)" },
  { operation: "domain.overview", label: "Domain overview" },
  { operation: "domain.keywords", label: "Ranked keywords" },
  { operation: "domain.pages", label: "Ranking pages" },
  { operation: "domain.competitors", label: "Search competitors" },
  { operation: "backlinks.summary", label: "Backlink summary" },
  { operation: "backlinks.rows", label: "Backlink list" },
  { operation: "backlinks.referringDomains", label: "Referring domains" },
  { operation: "backlinks.pages", label: "Linked pages" },
  { operation: "backlinks.history", label: "Backlink history" },
  { operation: "business.listings", label: "Business listings" },
  { operation: "business.categories", label: "Business categories" },
  { operation: "business.info", label: "Business profiles" },
  { operation: "business.questions", label: "Business questions and answers" },
  { operation: "business.reviewsPost", label: "Queue business reviews" },
  { operation: "business.updatesPost", label: "Queue business updates" },
  { operation: "business.taskGet", label: "Collect queued business data" },
  { operation: "audit.lighthouse", label: "Lighthouse performance audits" },
  { operation: "ai.mentions", label: "AI mentions" },
  { operation: "ai.metrics", label: "AI mention metrics" },
  { operation: "ai.crossMetrics", label: "AI share of voice" },
  { operation: "ai.pages", label: "AI cited pages" },
  { operation: "ai.response", label: "AI responses" },
  { operation: "ai.trackingLive", label: "Live prompt tracking" },
  { operation: "ai.trackingPost", label: "Queue prompt tracking" },
  { operation: "ai.trackingGet", label: "Collect queued prompt tracking" },
] as const;

export interface ProviderExecution {
  /** Only the operator's budgeted verification runner sets this. */
  readonly purpose?: "verification";
  readonly organizationId: string;
  readonly provider: SeoProviderId;
  readonly revision: number;
  readonly credentialVersion: string | null;
  readonly source: "database" | "environment";
  readonly authorization: string;
}

export type ProviderExecutionReference = Pick<
  ProviderExecution,
  "organizationId" | "provider" | "revision" | "credentialVersion"
>;

export interface ProviderTransportAdapter {
  readonly id: SeoProviderId;
  capabilities(): Array<{
    operation: string;
    label: string;
    state: CapabilityState;
  }>;
  testConnection(
    execution: ProviderExecution,
  ): Promise<ProviderResult<{ authenticated: boolean }>>;
  request(
    execution: ProviderExecution,
    url: string,
    init: RequestInit,
  ): Promise<Response>;
}

// Canonical metrics: CPC in USD, competition 0-1, unknown values remain null.
export type KeywordMetricRow = {
  keyword: string;
  searchVolume: number | null;
  cpc: number | null;
  competition: number | null;
  competitionLevel: string | null;
  keywordDifficulty: number | null;
  intent: string | null;
  monthlySearches: MonthlySearch[];
};

export interface KeywordMetricsRequest {
  keywords: string[];
  locationCode: number;
  languageCode: string;
  creditFeature: CreditFeature;
  includeClickstreamData?: boolean;
  locationName?: string;
}
