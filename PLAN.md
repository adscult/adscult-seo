# PLAN.md — Pluggable SEO Providers with an Admin Switcher

Status: DataForSEO migration and provider administration are implemented and regression-checked. Treg has a verified keyword/SERP/domain subset and is active locally. Rank trackers now offer AnyAPI (the default for new Treg trackers) or DataForSEO, with separate AnyAPI device history. Broader Treg coverage and deployment gates remain unverified. See [the implementation handoff](docs/maintainers/provider-implementation.md) for evidence and limitations.
Treg follow-up: 28 documented catalog route mappings are implemented. After authorization for a USD 0.25 verification budget, seven paid probes passed at a total cost of USD 0.087116. Verified keyword/SERP/domain operations are enabled and Treg is active locally at revision 2. Unverified operations and hosted resale remain gated. See [the operation contracts](docs/maintainers/treg-operation-contracts.md).
Backlinks follow-up: list, referring-domain, linked-page and history routes passed live validation and are enabled through Treg. The backlink overview now includes its verified subfolder/history dependencies. See the operation contracts for receipts and the remaining verification budget.

Target: OpenSEO (`every-app/open-seo`).
Goal: support DataForSEO directly and verified SEO operations through Treg, with an administrator-controlled switch that does not require an application restart.

## 1. Scope and implementation principles

Preserve existing DataForSEO functionality while introducing a provider-neutral boundary. Enable Treg only for operations whose endpoint, authentication, response schema, and data meaning have been verified.

Required outcomes:

- Administrators can configure credentials, test a candidate configuration, review supported features, and activate it.
- Feature services consume normalized results rather than vendor response objects.
- Unsupported operations produce an explicit unavailable state, never fabricated zero metrics.
- Settings changes affect new work; requests and asynchronous jobs already started retain their original provider identity.
- Credentials remain server-side and are encrypted when stored in the database.
- Switching and rollback work across all application instances.

Initial scope excludes automatic cross-provider failover, custom arbitrary API URLs, and claims of full feature parity. Automatic failover could introduce extra charges or change metric meaning; add it only through a separately specified policy.

“No restart required” is the switching guarantee. Zero downtime for a deployment depends on infrastructure, migration compatibility, health checks, and draining; it is not guaranteed by a provider factory alone.

## 2. Discovery gate: verify before coding

Inspect the actual target checkout, record its commit SHA, and read its contributor instructions. The paths and commands in the original plan are starting points, not verified repository facts.

Inspect:

- Existing DataForSEO client, credentials, response parsing, error handling, and billing behavior.
- All provider call sites: feature services, scheduled jobs, workers, server functions, exports, and tests.
- Existing database abstraction, schema exports, migrations, settings model, tenancy, and authorization.
- Supported PostgreSQL, SQLite, and D1 deployment modes, if present.
- Route conventions, package scripts, runtime environment access, Docker build and entrypoint.

Suggested searches, adjusted to the checkout:

```bash
rg --files -g AGENTS.md -g package.json -g '*drizzle*' -g '*schema*' -g '*compose*' -g '*Dockerfile*'
rg -n 'dataforseo|DATAFORSEO|task_post|task_get' src drizzle
rg -n 'admin|role|tenant|workspace|settings' src
```

Deliver an operation inventory before choosing the final interface:

| Operation family          | What to inspect                                                 | Treg release gate                              |
| ------------------------- | --------------------------------------------------------------- | ---------------------------------------------- |
| Live SERP / rank tracking | Engine, device, market, result depth, organic ranking semantics | Documented route and representative fixture    |
| Keyword research          | Metrics, suggestions, related terms, trends, batch limits       | Each consumed operation mapped separately      |
| Domain overview           | Traffic estimates, keyword counts, date ranges                  | Equivalent definitions or explicit differences |
| Backlinks                 | Summary, list, pagination, referring domains                    | Verified coverage and pagination               |
| Site audits               | Crawl submission, polling, result retrieval                     | Complete task lifecycle or unavailable state   |

Do not assume four generic methods cover every existing feature. A keyword metrics endpoint does not replace keyword discovery. SERP retrieval does not replace a crawl audit.

### Treg evidence required

For each proposed operation record the official documentation URL, HTTP method, exact route, authentication scheme, upstream vendor, request example, sanitized response, error example, pagination, rate limits, and expected billing behavior. Record the verification date.

Treg and AnyAPI are not interchangeable names for an API contract. Do not invent a metadata ping, keyword endpoint, domain endpoint, or SerpApi proxy route. Do not assume `https://api.treg.to` or Bearer authentication until verified for the selected interface. If documentation or account access is missing, leave that capability unverified and keep it unavailable for activation.

Exit gate: the existing application dependencies are mapped, DataForSEO behavior is documented, and at least one intended Treg operation has a concrete contract. Missing Treg evidence must not block the provider abstraction and DataForSEO regression work.

## 3. Architecture and module responsibilities

Request flow: authenticated feature service → provider resolver → capability check → adapter → validated vendor response → normalized result → existing feature presentation.

Proposed modules, subject to repository conventions:

| Module                                              | Responsibility                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `src/server/providers/types.ts`                     | Operation contracts, normalized results, typed errors              |
| `src/server/providers/registry.ts`                  | Explicit provider IDs and adapter construction                     |
| `src/server/providers/resolver.ts`                  | Effective settings, credential source, immutable execution context |
| `src/server/providers/dataforseo/`                  | Wrap the existing client and normalize responses                   |
| `src/server/providers/treg/`                        | Verified Treg transport and operation mappings                     |
| `src/server/features/settings/provider-settings.ts` | Authorized configuration, testing, activation, audit               |
| Existing settings route                             | Admin UI integrated into current navigation                        |

Keep provider modules server-only. The registry must reject unknown provider IDs rather than defaulting silently. Reuse existing transport, database, validation, and authorization utilities where possible.

## 4. Contract and data semantics

Use operation-level capabilities and a discriminated result type. The following is a design sketch, not a replacement for the inventory-derived contract:

```typescript
type ProviderId = "dataforseo" | "treg";
type CapabilityState = "available" | "unsupported" | "unverified";
type ProviderErrorCode =
  | "UNSUPPORTED"
  | "NOT_CONFIGURED"
  | "INVALID_REQUEST"
  | "AUTH_FAILED"
  | "RATE_LIMITED"
  | "QUOTA_EXCEEDED"
  | "TIMEOUT"
  | "UPSTREAM_ERROR"
  | "INVALID_RESPONSE";

interface ResultMeta {
  provider: ProviderId;
  upstreamVendor?: string;
  operation: string;
  settingsRevision: number;
  fetchedAt: string;
  sourceUpdatedAt?: string;
  warnings: string[];
}

type ProviderResult<T> =
  | { ok: true; data: T; meta: ResultMeta }
  | {
      ok: false;
      error: {
        code: ProviderErrorCode;
        message: string;
        retryable: boolean;
        retryAfterMs?: number;
      };
      meta: ResultMeta;
    };
```

Contract rules:

- Carry explicit market/location, language, search engine, device, depth, and date scope where relevant. Validate supported combinations; do not silently substitute locations.
- Use `null` for unknown metrics and `0` only for a measured zero. Never coerce absent volume, traffic, or backlink counts to zero.
- Define CPC currency, competition scale, traffic units, estimation period, and metric source. Keep unrelated vendor authority scores separately named; do not imply they are interchangeable.
- Distinguish organic position from absolute SERP position and identify result type. Preserve rank-tracking semantics.
- Include pagination/cursors, limits, total-count availability, and partial-response warnings.
- Preserve per-keyword success/failure for batches, including duplicate keywords and input correspondence.
- Validate HTTP status AND vendor-level/task-level status before normalization.
- Keep raw upstream payloads out of browser responses and routine logs.

Audit submission and retrieval need explicit task contracts if the current app uses them. Store provider ID, upstream task ID, operation, configuration revision, and credential-version reference. A queued task must never be polled through a different provider after a switch.

## 5. Settings and secrets

First decide scope from the existing tenancy model. Use a singleton only for an installation-wide setting; use workspace scope if provider selection is tenant-specific. All reads, caches, mutations, and audit events must use the same scope.

Proposed logical records:

| Record               | Fields / purpose                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------- |
| Provider settings    | Scope key, active provider (nullable), monotonic revision, updated time, updated by       |
| Provider credentials | Scope, provider, encrypted credential bundle, key version, credential version, timestamps |
| Provider audit event | Actor, scope, old/new provider, revision, action, outcome, timestamp; no secret values    |

Adapt tables to existing conventions instead of duplicating a suitable settings system. Generate migrations for every supported runtime in scope. PostgreSQL and SQLite/D1 need dialect-appropriate constraints and timestamp handling.

Effective configuration:

1. An explicitly saved database selection wins.
2. Otherwise use a validated `SEO_PROVIDER` environment value.
3. Otherwise preserve the existing DataForSEO default.
4. Resolve credentials for that provider from its database override, then its environment bundle.

Do not seed a Treg default during migration or store a default that unintentionally shadows environment configuration. Missing credentials must produce `NOT_CONFIGURED`, not an invisible switch to another vendor.

DataForSEO's direct REST API uses HTTP Basic authentication with API login and API password. Model these as one credential bundle. Do not label an arbitrary value `DATAFORSEO_API_KEY` and send it as Bearer. If the existing application uses a pre-encoded Basic value, retain compatibility through an explicit, validated mapping.

Credential input semantics:

- Omitted / unchanged: preserve the existing override.
- Replace: validate and encrypt the entire submitted bundle.
- Use environment: explicitly delete the database override and resolve the server environment bundle.
- Empty form fields are not a deletion command; reject incomplete replacement bundles.

Use a managed secrets store or authenticated encryption with an externally supplied key. Keep encryption keys outside the database, support key versions, and document restore/rotation. Never log credentials, return saved credentials, include them in audit diffs, or place them in client-exposed environment variables. Show only configured status, source, and last test time in the UI.

## 6. Provider adapters and transport

### DataForSEO

Wrap existing, working request code first. Preserve current behavior and map errors at the boundary. Avoid rewriting all services and transport simultaneously. Build fixtures for each operation used by the application before routing production features through the adapter.

### Treg

Implement only verified operation mappings. Validate responses with runtime schemas. Capabilities start as unverified, become available after contract and smoke validation, or become unsupported when confirmed absent. A failed connection is an operational failure, not proof that an operation is unsupported.

### Shared transport requirements

- Use explicit connect/request deadlines, cancellation, bounded concurrency, and payload/batch limits.
- Retry only when safe, with a bounded backoff and jitter; respect upstream retry guidance.
- Do not automatically retry potentially billable submissions after an ambiguous timeout. Use documented idempotency or task reconciliation where supported.
- Do not retry authentication failures or invalid inputs.
- Allowlist verified vendor hosts and route definitions. Do not expose a general-purpose URL proxy through settings or connection tests.
- Test authentication with a documented, low-cost endpoint where available. If a test is billable, show that before the user starts it.
- Report authentication, required-operation readiness, and optional feature availability separately. A successful connection test does not prove full parity.

## 7. Runtime switching and consistency

For the initial implementation, read the committed settings revision from the shared database at the start of each new request/job. Cache adapter configuration only by scope, provider, revision, and credential version. This favors predictable switching over a premature 30-second settings cache.

Activation flow:

1. Authorize the administrator and validate the candidate configuration.
2. Test the candidate outside the database transaction, binding the result to its credential version and capability configuration.
3. Require successful readiness checks for a declared set of must-have operations. Show optional feature loss explicitly before activation.
4. In a transaction, compare the expected revision, save the exact tested configuration, increment revision, and write an audit event.
5. Return a conflict if another admin changed the configuration. Never overwrite silently.
6. New executions observe the new committed revision; in-flight executions retain their resolved context.

For async tasks, retain the encrypted credential version needed to finish existing work until completion or expiry. Define drain/cancel handling when a credential is revoked. Persist references, never plaintext credentials, in queued jobs.

If the settings database is unavailable, do not silently fall back to environment defaults for new work: return a clear configuration-unavailable error. Existing resolved executions may finish.

If a shared cache is introduced later, specify invalidation across instances, a maximum propagation delay, and failure behavior. Local invalidation alone is insufficient in a multi-instance deployment.

Result-cache keys must include scope, provider/upstream identity, operation, normalized inputs, and contract version. Record source provenance on persisted results so historical reports remain interpretable after switching.

## 8. Admin server functions and UI

Implement authorization on every server function, including tests and reads. Reuse established CSRF/origin protections and schema validation. Rate-limit connection tests and settings writes.

| Action          | Behavior                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| Read settings   | Return effective provider, source, revision, secret-presence flags, capability matrix, readiness status |
| Save candidate  | Store inactive configuration securely; do not activate implicitly                                       |
| Test candidate  | Validate exact candidate and return sanitized, timestamped readiness results                            |
| Activate        | Require expected revision and a valid test of the exact candidate; commit atomically                    |
| Use environment | Explicit action with preview of effective provider/credential availability                              |
| Roll back       | Activate a retained, valid configuration as a new audited revision                                      |

The UI should include:

- Separate current active provider and editable candidate state.
- Provider-specific credential inputs: DataForSEO login/password; Treg fields matching verified documentation.
- Explicit replace/use-environment actions; never echo saved secrets into inputs.
- Feature matrix with Available, Unsupported, Unverified, and clear operational errors.
- Test result timestamp, configuration source, and any charge notice.
- Save candidate, Test, and Activate controls with loading/error/conflict states.
- A warning listing optional features that will become unavailable.
- Accessible labels, keyboard operation, and status text that does not rely only on color.

Unsupported feature pages show “Not supported by the active provider.” Authentication failures, quota errors, timeouts, no results, and unsupported operations must have distinct UI states.

## 9. Delivery sequence and acceptance gates

| Phase                   | Work                                                      | Exit gate                                              |
| ----------------------- | --------------------------------------------------------- | ------------------------------------------------------ |
| 0 — Discovery           | Inspect checkout, map operations, verify vendor contracts | Evidence matrix and unresolved dependencies documented |
| 1 — Contract            | Types, capability model, typed errors, fixtures           | Existing feature semantics covered                     |
| 2 — DataForSEO adapter  | Wrap current client and migrate one feature at a time     | Baseline behavior retained                             |
| 3 — Settings            | Schema, encryption, resolver, authorization, revisions    | Secure configuration and atomic updates tested         |
| 4 — Treg adapter        | Verified operations and schema normalization              | Fixtures pass; supported operations smoke-tested       |
| 5 — Admin UI            | Candidate/test/activation flow and feature availability   | End-to-end switching works                             |
| 6 — Remaining consumers | Jobs, audits, exports, cache provenance                   | No unintended direct vendor dependencies remain        |
| 7 — Deployment          | Migration gate, health checks, rollback rehearsal         | Release criteria below pass                            |

Keep each phase reviewable. Run the repository's actual lint, typecheck, build, and test scripts; do not assume `pnpm db:migrate:pg`, `pnpm tsc --noEmit`, or `node server.js` are valid entrypoints.

## 10. Verification matrix

| Scenario                                    | Expected result                                                 |
| ------------------------------------------- | --------------------------------------------------------------- |
| Upgrade without new settings                | Existing DataForSEO configuration continues working             |
| Invalid provider ID or absent credentials   | Explicit configuration error; no silent fallback                |
| Database override / environment / default   | Documented precedence, including explicit override removal      |
| Non-admin request or cross-workspace access | Denied server-side; no secret or settings leakage               |
| Secret replacement and encryption rotation  | Stored encrypted; old jobs handled by defined lifecycle         |
| HTTP 200 with vendor task failure           | Typed failure, not success                                      |
| Missing metric versus measured zero         | Distinct normalized values and display                          |
| Unsupported backlinks or audits             | Explicit unavailable state; no fabricated empty result          |
| Keyword batch partly fails                  | Successful items preserved; failures identified                 |
| Pagination and rank semantics               | Stable, correct ordering and complete requested scope           |
| Authentication / quota / timeout failures   | Correct UI state and bounded, safe retry policy                 |
| Two admins save concurrently                | One update succeeds; stale revision conflicts                   |
| Switch with two app instances               | New work uses committed revision on both instances              |
| Switch during request or async job          | Existing work retains provider and task identity                |
| Provider switch with cached results         | No cross-provider or cross-workspace cache leakage              |
| Database unavailable                        | Explicit failure for new resolution; no unexpected vendor calls |
| Rollback after activation                   | Previous usable configuration restored as a new revision        |

Use sanitized fixtures for normal tests. Keep live vendor tests opt-in, low-volume, and within an agreed spend limit. A lack of live credentials must be reported as an unverified integration, not a passing test.

## 11. Deployment, observability, and rollback

- Confirm the actual Coolify/Docker runtime and existing authentication mode; do not introduce `AUTH_MODE=hosted` without checking its semantics.
- Preserve the current provider default during deployment. Supply optional provider credentials through server secrets, plus the encryption key if database credentials are enabled.
- Apply additive, backward-compatible migrations through a single controlled migration job or a lock-protected migration step. Do not let every replica race to migrate at startup.
- Back up settings and ensure encryption-key recovery before migration. Test the supported database variants in scope.
- Make readiness depend on application/database configuration; avoid paid vendor calls on every health probe.
- Log request ID, operation, provider, revision, latency, sanitized error category, and available usage data. Do not log secrets or raw request/response bodies by default.
- Track provider error rate, rate limits, latency, unsupported requests, activation events, and billable retry anomalies.
- Roll out first with DataForSEO active; validate Treg in staging, then activate only after readiness gates pass.
- For rollback, activate the previous usable configuration as a new revision, preserve provenance, and drain in-flight work. Retain additive tables during application rollback; do not run destructive down migrations as a routine response.

## 12. Definition of done and handoff

- [x] Target checkout SHA, real paths, scripts, tenancy model, and deployment modes documented.
- [x] All consumed operations covered by an adapter or an explicit unavailable state.
- [x] Treg endpoint/authentication evidence recorded; no invented routes or assumed parity.
- [x] Existing DataForSEO functionality passes regression checks.
- [x] Credentials encrypted at rest, redacted in logs, absent from client bundles and responses.
- [x] Settings precedence, concurrency, local multi-process switching, and job continuity verified on SQLite/Postgres. Deployed-instance validation remains a release gate.
- [ ] UI distinguishes unsupported, empty, partial, and failed results.
- [x] Required checks and production build pass using repository scripts. Final Linux CI passed; all 1,700 tests passed with four workers. Windows checkout limitations are documented in the handoff.
- [ ] Migration, restore, credential rotation, and provider rollback documented and exercised.
- [x] Handoff lists changed files, migrations, environment variables, test results, supported operations, and remaining limitations.

## 13. Reference notes

Reviewed on 19 October 2026 (UTC). Public sources establish vendor context; this plan does not claim a full audit of the target checkout or live account access.

- OpenSEO repository: https://github.com/every-app/open-seo
- DataForSEO direct API authentication: https://docs.dataforseo.com/v3/auth/
- Treg catalog for operation discovery: https://treg.to/catalog

DataForSEO authentication is verified against its official documentation. Exact Treg SEO routes, authentication for the chosen interface, feature parity, account permissions, pricing, and all repository-specific file paths remain implementation verification gates.
