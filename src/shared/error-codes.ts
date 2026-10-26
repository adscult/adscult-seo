import { z } from "zod";

const ERROR_CODES = [
  "UNAUTHENTICATED",
  "AUTH_CONFIG_MISSING",
  "PAYMENT_REQUIRED",
  "INSUFFICIENT_CREDITS",
  "FORBIDDEN",
  "NOT_FOUND",
  "AUDIT_CAPACITY_REACHED",
  "AUDIT_PAGE_LIMIT_EXCEEDED",
  "AUDIT_ALREADY_RUNNING",
  "AUDIT_RENDERING_UNAVAILABLE",
  "VALIDATION_ERROR",
  "UNKNOWN_LOCATION",
  "CRAWL_TARGET_BLOCKED",
  "BACKLINKS_BILLING_ISSUE",
  "AI_SEARCH_BILLING_ISSUE",
  "AI_VISIBILITY_ERROR",
  "DATAFORSEO_AUTH_FAILED",
  "SEO_PROVIDER_AUTH_FAILED",
  "SEO_PROVIDER_NOT_CONFIGURED",
  "SEO_PROVIDER_UNSUPPORTED",
  "SEO_PROVIDER_CONFIGURATION_UNAVAILABLE",
  "SEO_PROVIDER_QUOTA_EXCEEDED",
  "SEO_PROVIDER_TIMEOUT",
  "RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE",
  "CONFLICT",
  "INTERNAL_ERROR",
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

const NON_REPORTABLE_ERROR_CODES = new Set<ErrorCode>([
  "SEO_PROVIDER_AUTH_FAILED",
  "SEO_PROVIDER_QUOTA_EXCEEDED",
  "SEO_PROVIDER_TIMEOUT",
  "SEO_PROVIDER_NOT_CONFIGURED",
  "SEO_PROVIDER_UNSUPPORTED",
  "UNAUTHENTICATED",
  // External throttling (Google Analytics quota, Autumn, DataForSEO): expected
  // and transient, and nothing in the app can act on it.
  "RATE_LIMITED",
  "NOT_FOUND",
  "PAYMENT_REQUIRED",
  "INSUFFICIENT_CREDITS",
  "VALIDATION_ERROR",
  "UNKNOWN_LOCATION",
  "AI_VISIBILITY_ERROR",
  "AUDIT_CAPACITY_REACHED",
  "AUDIT_PAGE_LIMIT_EXCEEDED",
  "AUDIT_ALREADY_RUNNING",
  "AUDIT_RENDERING_UNAVAILABLE",
  // An external provider (DataForSEO) failing on its own side. Nothing in the
  // app to fix, and it drowned real exceptions. Note the error handlers only
  // log what they capture, so every throw site warns on its own line to keep
  // the failure rate visible in Workers Observability.
  "UPSTREAM_UNAVAILABLE",
]);

export function isErrorCode(value: string): value is ErrorCode {
  return errorCodeSchema.safeParse(value).success;
}

export function shouldCaptureAppErrorCode(
  code: ErrorCode | null | undefined,
): boolean {
  return code == null || !NON_REPORTABLE_ERROR_CODES.has(code);
}
