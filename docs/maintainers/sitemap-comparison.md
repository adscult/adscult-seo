# Sitemap page comparison

The project’s **Research → Page gaps** screen compares public sitemap URLs with up to three competitors. Inputs start with the project domain and saved competitors; edits affect only the comparison. Results stay in the project’s browser query cache for up to an hour while navigating the app. CSV export retains the current filtered suggestions. Comparisons are not stored in the database.

The authenticated server function uses the existing project authorization gate, then calls `PageGapService` and `SitemapRepository`. Public HTTP fetching does not use an SEO vendor or purchase API results. The repository validates start URLs with the audit URL policy and resolves homepage redirects before discovering same-site sitemap documents.

Comparison discovery uses the shared audit reader with explicit limits: 20 documents, 5,000 URLs and a 45-second discovery deadline per site. Existing per-document byte, timeout and nesting limits still apply. Non-product sitemap shards are read first, serially, so a large catalog does not immediately consume the URL allowance. Existing audits retain their default discovery order and concurrency. Unreadable own sitemaps suppress suggestions; partial coverage is shown in the UI and CSV.

Topics come from URL slugs, with page type and word tokens used to group equivalent candidates. Price thresholds and model numbers are retained. Query variants and repeated URLs from one competitor cannot inflate its coverage. Exact topic matches are excluded; token overlap only surfaces an existing page to review. Suggestions prioritize category, service and content opportunities over products, then competitor coverage. The response includes at most 200 suggestions and summary counts rather than entire URL inventories.

URL comparisons cannot establish content equivalence, business relevance, search demand, indexing or the absence of pages outside sitemaps. The UI presents candidates for review and links to their evidence. It does not create pages automatically.
