import type { providerOperations } from "../types";

type Route = {
  path: string;
  endpoint: string;
  method: "GET" | "POST";
  operations: Array<(typeof providerOperations)[number]["operation"]>;
  smokeVerified: boolean;
};

// Exact upstream paths and catalog IDs read from
// https://treg.to/catalog/providers/dataforseo on 2026-10-20.
// Native DataForSEO bodies/results are preserved. A documented contract is
// implemented here before its capability can pass live smoke verification.
// Missing or incompatible routes are deliberately absent (no generic proxy).
export const tregRoutes: readonly Route[] = [
  {
    path: "/v3/serp/google/organic/live/advanced",
    endpoint: "dataforseo.x.serp-google-organic-live-advanced",
    method: "POST",
    operations: ["serp.live", "serp.rankCheck"],
    smokeVerified: true,
  },
  {
    path: "/v3/serp/google/maps/live/advanced",
    endpoint: "dataforseo.x.serp-google-maps-live-advanced",
    method: "POST",
    operations: ["serp.local"],
    smokeVerified: false,
  },
  {
    path: "/v3/serp/google/local_finder/live/advanced",
    endpoint: "dataforseo.x.serp-google-local-finder-live-advanced",
    method: "POST",
    operations: ["serp.local"],
    smokeVerified: false,
  },
  {
    path: "/v3/serp/google/locations/{country}",
    endpoint: "dataforseo.x.serp-google-locations-country",
    method: "GET",
    operations: ["serp.locations"],
    smokeVerified: true,
  },
  {
    path: "/v3/dataforseo_labs/google/related_keywords/live",
    endpoint: "dataforseo.google.keywords.ideas",
    method: "POST",
    operations: ["keywords.related"],
    smokeVerified: true,
  },
  {
    path: "/v3/dataforseo_labs/google/keyword_suggestions/live",
    endpoint: "dataforseo.x.dataforseo-labs-google-keyword-suggestions-live",
    method: "POST",
    operations: ["keywords.suggestions"],
    smokeVerified: true,
  },
  {
    path: "/v3/dataforseo_labs/google/keyword_ideas/live",
    endpoint: "dataforseo.x.dataforseo-labs-google-keyword-ideas-live",
    method: "POST",
    operations: ["keywords.ideas"],
    smokeVerified: true,
  },
  {
    path: "/v3/dataforseo_labs/google/keyword_overview/live",
    endpoint: "dataforseo.x.dataforseo-labs-google-keyword-overview-live",
    method: "POST",
    operations: ["keywords.overview"],
    smokeVerified: true,
  },
  {
    path: "/v3/keywords_data/google_ads/keywords_for_keywords/live",
    endpoint:
      "dataforseo.x.keywords-data-google-ads-keywords-for-keywords-live",
    method: "POST",
    operations: ["keywords.adsIdeas"],
    smokeVerified: false,
  },
  {
    path: "/v3/keywords_data/google_ads/search_volume/live",
    endpoint: "dataforseo.google.keywords.volume",
    method: "POST",
    operations: ["keywords.adsVolume"],
    smokeVerified: false,
  },
  {
    path: "/v3/dataforseo_labs/google/domain_rank_overview/live",
    endpoint: "dataforseo.x.dataforseo-labs-google-domain-rank-overview-live",
    method: "POST",
    operations: ["domain.overview"],
    smokeVerified: true,
  },
  {
    path: "/v3/dataforseo_labs/google/ranked_keywords/live",
    endpoint: "dataforseo.google.domain.ranked_keywords",
    method: "POST",
    operations: ["domain.keywords"],
    smokeVerified: false,
  },
  {
    path: "/v3/dataforseo_labs/google/relevant_pages/live",
    endpoint: "dataforseo.x.dataforseo-labs-google-relevant-pages-live",
    method: "POST",
    operations: ["domain.pages"],
    smokeVerified: false,
  },
  {
    path: "/v3/dataforseo_labs/google/serp_competitors/live",
    endpoint: "dataforseo.x.dataforseo-labs-google-serp-competitors-live",
    method: "POST",
    operations: ["domain.competitors"],
    smokeVerified: false,
  },
  {
    path: "/v3/backlinks/summary/live",
    endpoint: "dataforseo.web.backlinks.summary",
    method: "POST",
    operations: ["backlinks.summary"],
    smokeVerified: true,
  },
  {
    path: "/v3/backlinks/backlinks/live",
    endpoint: "dataforseo.web.backlinks.list",
    method: "POST",
    operations: ["backlinks.rows", "backlinks.summary"],
    smokeVerified: true,
  },
  {
    path: "/v3/backlinks/referring_domains/live",
    endpoint: "dataforseo.web.linking_domains.list",
    method: "POST",
    operations: ["backlinks.referringDomains"],
    smokeVerified: true,
  },
  {
    path: "/v3/backlinks/domain_pages_summary/live",
    endpoint: "dataforseo.x.backlinks-domain-pages-summary-live",
    method: "POST",
    operations: ["backlinks.pages"],
    smokeVerified: true,
  },
  {
    path: "/v3/backlinks/history/live",
    endpoint: "dataforseo.x.backlinks-history-live",
    method: "POST",
    operations: ["backlinks.history", "backlinks.summary"],
    smokeVerified: true,
  },
  {
    path: "/v3/business_data/business_listings/search/live",
    endpoint: "dataforseo.x.business-data-business-listings-search-live",
    method: "POST",
    operations: ["business.listings"],
    smokeVerified: false,
  },
  {
    path: "/v3/business_data/google/my_business_info/live",
    endpoint: "dataforseo.x.business-data-google-my-business-info-live",
    method: "POST",
    operations: ["business.info"],
    smokeVerified: false,
  },
  {
    path: "/v3/business_data/google/questions_and_answers/live",
    endpoint: "dataforseo.x.business-data-google-questions-and-answers-live",
    method: "POST",
    operations: ["business.questions"],
    smokeVerified: false,
  },
  {
    path: "/v3/business_data/google/reviews/task_post",
    endpoint: "dataforseo.x.business-data-google-reviews-task-post",
    method: "POST",
    operations: ["business.reviewsPost"],
    smokeVerified: false,
  },
  {
    path: "/v3/business_data/google/extended_reviews/task_post",
    endpoint: "dataforseo.x.business-data-google-extended-reviews-task-post",
    method: "POST",
    operations: ["business.reviewsPost"],
    smokeVerified: false,
  },
  {
    path: "/v3/business_data/google/my_business_updates/task_post",
    endpoint: "dataforseo.x.business-data-google-my-business-updates-task-post",
    method: "POST",
    operations: ["business.updatesPost"],
    smokeVerified: false,
  },
  {
    path: "/v3/business_data/google/reviews/task_get/{id}",
    endpoint: "dataforseo.x.business-data-google-reviews-task-get",
    method: "GET",
    operations: ["business.taskGet"],
    smokeVerified: false,
  },
  {
    path: "/v3/business_data/google/extended_reviews/task_get/{id}",
    endpoint: "dataforseo.x.business-data-google-extended-reviews-task-get",
    method: "GET",
    operations: ["business.taskGet"],
    smokeVerified: false,
  },
  {
    path: "/v3/business_data/google/my_business_updates/task_get/{id}",
    endpoint: "dataforseo.x.business-data-google-my-business-updates-task-get",
    method: "GET",
    operations: ["business.taskGet"],
    smokeVerified: false,
  },
];
