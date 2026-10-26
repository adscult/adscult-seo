import { getScopedProviderExecution } from "@/server/providers/context";
import { getProviderAdapter } from "@/server/providers/registry";
import { dataforseoAccountErrorCode } from "@/server/providers/dataforseo/account-error";
import type { ProviderExecution } from "@/server/providers/types";
import { AppError } from "@/server/lib/errors";
import { getRequiredEnvValue } from "@/server/lib/runtime-env";
import type { ErrorCode } from "@/shared/error-codes";
// No runtime cycle: envelope.ts imports only the DataforseoErrorClassifier
// type from here.
import {
  warnIfUpstreamResponseFailed,
  DataforseoChargedTaskError,
  type DataforseoResponseLike,
  type DataforseoTaskLike,
} from "@/server/lib/dataforseo/envelope";

const API_BASE = "https://api.dataforseo.com";
// Safety ceiling on any live call (Lighthouse is the slowest, ~tens of seconds).
const DATAFORSEO_REQUEST_TIMEOUT_MS = 60_000;
// Retry idempotent reads on transient 5xx. Total attempts = retries + 1; the
// shared request-timeout signal still caps overall wall time.
const DATAFORSEO_MAX_RETRIES = 2;
const DATAFORSEO_RETRY_BACKOFF_MS = 250;

/**
 * Translates a DataForSEO HTTP/task failure into a product-specific AppError
 * (e.g. "billing issue"). Returns null when the failure isn't one this
 * classifier recognises, so the caller can fall back to a generic error. See
 * {@link createDataforseoBillingClassifier}.
 */
export type DataforseoErrorClassifier = (
  status: number | undefined,
  details: string,
  path: string,
) => AppError | null;

function formatDataforseoRequestPath(url: RequestInfo): string {
  const rawUrl = typeof url === "string" ? url : url.url;
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return rawUrl;
  }
}

/**
 * The single authenticated `fetch` used by every DataForSEO call. Throws on
 * non-2xx; task-level failures (which return HTTP 200) are handled downstream
 * by {@link assertOk}. An optional classifier maps recognised HTTP failures to
 * product errors.
 */
function createAuthenticatedFetch(
  classify?: DataforseoErrorClassifier,
  maxServerErrorRetries = DATAFORSEO_MAX_RETRIES,
) {
  return async (url: RequestInfo, init?: RequestInit): Promise<Response> => {
    const scopedExecution = await getScopedProviderExecution();
    // Loading the persistence seam only for scoped app requests preserves the
    // existing environment-only CLI and section-test entry points.
    const execution =
      scopedExecution &&
      new URL(typeof url === "string" ? url : url.url).pathname.includes(
        "/task_get/",
      )
        ? await (
            await import("@/server/providers/task-context")
          ).resolveTaskExecution(
            new URL(typeof url === "string" ? url : url.url).pathname,
            scopedExecution,
          )
        : scopedExecution;
    const apiKey =
      execution?.authorization ??
      (await getRequiredEnvValue("DATAFORSEO_API_KEY"));
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Basic ${apiKey}`);
    const requestExecution: ProviderExecution =
      execution ??
      Object.freeze({
        organizationId: "installation-cli",
        provider: "dataforseo",
        revision: 0,
        credentialVersion: null,
        source: "environment",
        authorization: apiKey,
      });
    const adapter = getProviderAdapter(requestExecution.provider);
    // Resolve the signal once so retries share the overall request timeout
    // rather than restarting a fresh 60s budget on each attempt.
    const signal =
      init?.signal ?? AbortSignal.timeout(DATAFORSEO_REQUEST_TIMEOUT_MS);

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await adapter.request(
          requestExecution,
          typeof url === "string" ? url : url.url,
          { ...init, headers, signal },
        );
      } catch (error) {
        // Both abort flavours mean "we ran out of time", and neither carries a
        // useful name of its own: the shared budget above rejects with
        // TimeoutError, while Lighthouse passes its own AbortController
        // deadline via init.signal and rejects with AbortError. Classify them
        // so callers get a provider-degradation error instead of an anonymous
        // internal one. Deliberately not retried: a call that ran past the
        // deadline may already be billed by DataForSEO, and because this is not
        // a DataforseoChargedTaskError the customer is metered nothing for it,
        // so replaying would be spend we eat twice.
        if (
          error instanceof Error &&
          (error.name === "TimeoutError" || error.name === "AbortError")
        ) {
          const path = formatDataforseoRequestPath(url);
          const timeoutError = new AppError(
            "UPSTREAM_UNAVAILABLE",
            `DataForSEO request timed out on ${path}`,
            { provider: "dataforseo", providerPath: path },
          );
          timeoutError.name = "DataForSEOTimeoutError";
          throw timeoutError;
        }
        throw error;
      }
      if (response.ok) return response;

      // Transient upstream 5xx on an idempotent read -> back off and retry.
      if (
        requestExecution.provider === "dataforseo" &&
        response.status >= 500 &&
        attempt < maxServerErrorRetries
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, DATAFORSEO_RETRY_BACKOFF_MS * (attempt + 1)),
        );
        continue;
      }

      const rawText = await response.text();
      const path = formatDataforseoRequestPath(url);
      const accountCode = dataforseoAccountErrorCode(response.status);
      const classified =
        classify?.(response.status, rawText, path) ??
        (accountCode ? new AppError(accountCode) : null);
      if (classified) throw classified;

      const code: ErrorCode =
        response.status >= 500
          ? "UPSTREAM_UNAVAILABLE"
          : response.status === 429
            ? "RATE_LIMITED"
            : response.status === 401
              ? "DATAFORSEO_AUTH_FAILED"
              : "INTERNAL_ERROR";
      const error = new AppError(
        code,
        `DataForSEO HTTP ${response.status} on ${path}`,
        {
          provider: "dataforseo",
          providerStatus: String(response.status),
          providerPath: path,
        },
      );
      error.name = "DataForSEOHttpError";
      // UPSTREAM_UNAVAILABLE is non-reportable, and the error handlers only log
      // what they capture, so warn here to keep the provider's failure rate
      // visible in Workers Observability. Warn, not error: there is nothing in
      // the app to fix.
      if (code === "UPSTREAM_UNAVAILABLE")
        console.warn("dataforseo.upstream-http-failed", {
          event: "dataforseo.upstream-http-failed",
          path,
          status: response.status,
        });
      throw error;
    }
  };
}

type DataforseoRequestOptions = {
  /** Maps a recognised access / billing HTTP failure to a product error. */
  classify?: DataforseoErrorClassifier;
  /**
   * Billable POSTs default to no retries: a 5xx does not prove the provider
   * skipped the charge. Free GET collection retries transient 5xx.
   */
  maxServerErrorRetries?: number;
  /** The sandbox host validates requests like production at zero cost. */
  baseUrl?: string;
  signal?: AbortSignal;
};

async function requestDataforseo<TTask extends DataforseoTaskLike>(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  options: DataforseoRequestOptions,
): Promise<DataforseoResponseLike<TTask> | null> {
  const doFetch = createAuthenticatedFetch(
    options.classify,
    options.maxServerErrorRetries ??
      (method === "POST" ? 0 : DATAFORSEO_MAX_RETRIES),
  );
  const response = await doFetch(`${options.baseUrl ?? API_BASE}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    body: method === "POST" ? JSON.stringify(body) : undefined,
    signal: options.signal,
  });
  const text = await response.text();
  if (text === "") return null;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the task type is the caller's claim about the payload; billing metadata and item fields are validated downstream (envelope.ts + section Zod schemas)
  const parsed = JSON.parse(text) as DataforseoResponseLike<TTask>;
  if (path.endsWith("/task_post") && (await getScopedProviderExecution())) {
    try {
      await (
        await import("@/server/providers/task-context")
      ).recordSubmittedTasks(path, parsed);
    } catch {
      // A post can have been charged even if persistence then fails. Preserve
      // that charge at the metering boundary and never replay the submission.
      const costs = parsed.tasks?.map((task) => task.cost) ?? [];
      const costUsd = costs.reduce<number>(
        (sum, cost) =>
          sum +
          (typeof cost === "number" && Number.isFinite(cost) && cost >= 0
            ? cost
            : 0),
        0,
      );
      throw new DataforseoChargedTaskError(
        "Could not retain SEO task configuration. Do not retry this submission automatically.",
        { path: path.split("/").filter(Boolean), costUsd },
        false,
        "SEO_PROVIDER_CONFIGURATION_UNAVAILABLE",
      );
    }
  }
  warnIfUpstreamResponseFailed(parsed, path);
  return parsed;
}

/**
 * POST `tasks` (the standard array-of-task-payloads body) to a DataForSEO
 * endpoint and return the parsed response envelope. The task type parameter is
 * the caller's claim about the payload shape — fields we act on are validated
 * downstream (billing metadata in envelope.ts, items via the section fetchers'
 * Zod schemas). Auth is read per-call from the Worker env.
 */
export function dataforseoPost<
  TTask extends DataforseoTaskLike = DataforseoTaskLike,
>(
  path: string,
  tasks: unknown[],
  options: DataforseoRequestOptions = {},
): Promise<DataforseoResponseLike<TTask> | null> {
  return requestDataforseo("POST", path, tasks, options);
}

/**
 * POST like {@link dataforseoPost} but return the UN-CONSUMED Response
 * (headers only) — the same auth, retry policy, and HTTP-error ladder apply.
 * For the one endpoint whose body is too big to read eagerly: Lighthouse
 * gates its multi-MB body reads behind a parse lock in the audit worker, and
 * passes its own `signal` so the timeout can be cleared once headers arrive.
 */
export function dataforseoPostResponse(
  path: string,
  tasks: unknown[],
  options: DataforseoRequestOptions & { signal?: AbortSignal } = {},
): Promise<Response> {
  const doFetch = createAuthenticatedFetch(
    options.classify,
    options.maxServerErrorRetries ?? 0,
  );
  return doFetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(tasks),
    signal: options.signal,
  });
}

/** GET a DataForSEO endpoint (task_get collection, appendix/locations data). */
export function dataforseoGet<
  TTask extends DataforseoTaskLike = DataforseoTaskLike,
>(
  path: string,
  options: DataforseoRequestOptions = {},
): Promise<DataforseoResponseLike<TTask> | null> {
  return requestDataforseo("GET", path, undefined, options);
}
