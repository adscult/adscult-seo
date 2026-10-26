import { z } from "zod";
import type {
  ProviderExecution,
  ProviderResult,
  ProviderTransportAdapter,
} from "@/server/providers/types";
import { providerOperations } from "@/server/providers/types";
import { AppError } from "@/server/lib/errors";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { callTregEndpoint } from "./call";
import { tregRoutes } from "./routes";

// Keep the native DataForSEO parsers behind this compatibility adapter. Catalog
// route IDs are explicit; tokens never reach DataForSEO or a caller-supplied URL.
export const tregAdapter: ProviderTransportAdapter = {
  id: "treg",
  capabilities: () =>
    providerOperations.map(({ operation, label }) => {
      const routes = tregRoutes.filter((route) =>
        route.operations.includes(operation),
      );
      return {
        operation,
        label,
        state: !routes.length
          ? "unsupported"
          : routes.every((route) => route.smokeVerified)
            ? "available"
            : "unverified",
      };
    }),
  testConnection,
  request,
};

const taskBodySchema = z.array(z.record(z.string(), z.unknown())).length(1);
const responseSchema = z
  .object({
    status_code: z.number(),
    tasks: z
      .array(
        z.object({ cost: z.number().nonnegative().optional() }).passthrough(),
      )
      .nullable()
      .optional(),
  })
  .passthrough();

async function request(
  execution: ProviderExecution,
  url: string,
  init: RequestInit,
): Promise<Response> {
  if (execution.provider !== "treg")
    throw new AppError("SEO_PROVIDER_UNSUPPORTED");
  // Hosted resale also needs durable Treg receipts and reservation estimates
  // based on its catalog prices. Do not charge hosted users via native prices.
  if (await isHostedServerAuthMode())
    throw new AppError("SEO_PROVIDER_UNSUPPORTED");
  const target = new URL(url);
  if (
    target.origin !== "https://api.dataforseo.com" ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  )
    throw new AppError("VALIDATION_ERROR");
  const route = tregRoutes.find((item) =>
    new RegExp(
      `^${item.path.replace("{country}", "[a-zA-Z]{2}").replace("{id}", "[a-zA-Z0-9-]{1,128}")}$`,
    ).test(target.pathname),
  );
  if (!route) throw new AppError("SEO_PROVIDER_UNSUPPORTED");
  if (!route.smokeVerified && execution.purpose !== "verification")
    throw new AppError("SEO_PROVIDER_UNSUPPORTED");
  if ((init.method ?? "GET").toUpperCase() !== route.method)
    throw new AppError("VALIDATION_ERROR");
  let body: unknown;
  if (route.method === "POST") {
    if (typeof init.body !== "string") throw new AppError("VALIDATION_ERROR");
    try {
      body = taskBodySchema.parse(JSON.parse(init.body));
    } catch {
      throw new AppError("VALIDATION_ERROR");
    }
  }
  const query: Record<string, string> = {};
  if (route.path.includes("{country}"))
    query.country = target.pathname.split("/").at(-1)!.toLowerCase();
  if (route.path.includes("{id}"))
    query.id = target.pathname.split("/").at(-1)!;
  const { response, costMicro } = await callTregEndpoint(
    execution,
    route.endpoint,
    {
      body,
      query,
      signal: init.signal,
    },
  );
  const envelope = responseSchema.parse(await response.json());
  // Every supported POST contains one task. Replace the vendor's nominal cost
  // with Treg's settled cost (including cached hits and BYOK's zero charge).
  if (route.method === "POST") {
    if (envelope.tasks?.length !== 1)
      throw new AppError("UPSTREAM_UNAVAILABLE");
    envelope.cost = costMicro / 1_000_000;
    envelope.tasks[0].cost = costMicro / 1_000_000;
  }
  return Response.json(envelope, {
    headers: { "X-Treg-Cost-Micro": String(costMicro) },
  });
}

const accountSchema = z.object({
  org_id: z.number().int().positive(),
  org: z.string().min(1),
});

async function testConnection(
  execution: ProviderExecution,
): Promise<ProviderResult<{ authenticated: boolean }>> {
  const meta = {
    provider: execution.provider,
    upstreamVendor: "treg",
    operation: "connection.test",
    settingsRevision: execution.revision,
    fetchedAt: new Date().toISOString(),
    warnings: [
      "Authentication checks account access only. Feature availability is reported separately.",
    ],
  };
  type FailureCode = Extract<
    ProviderResult<never>,
    { ok: false }
  >["error"]["code"];
  const failure = (
    code: FailureCode,
  ): ProviderResult<{ authenticated: boolean }> => ({
    ok: false,
    error: {
      code,
      message: code,
      retryable: ["RATE_LIMITED", "TIMEOUT", "UPSTREAM_ERROR"].includes(code),
    },
    meta,
  });
  if (execution.provider !== "treg") return failure("UNSUPPORTED");
  try {
    // Same free account read as the official CLI's whoami; no /call request,
    // redirects, automatic retries, account details or balances in the result.
    const response = await fetch("https://treg.to/auth/me", {
      method: "GET",
      headers: { "X-Treg-Token": execution.authorization },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if ([401, 403].includes(response.status)) return failure("AUTH_FAILED");
    if (response.status === 429) return failure("RATE_LIMITED");
    if (!response.ok) return failure("UPSTREAM_ERROR");
    if (!accountSchema.safeParse(await response.json()).success)
      return failure("INVALID_RESPONSE");
    return { ok: true, data: { authenticated: true }, meta };
  } catch (error) {
    if (error instanceof SyntaxError) return failure("INVALID_RESPONSE");
    if (
      error instanceof Error &&
      ["AbortError", "TimeoutError"].includes(error.name)
    )
      return failure("TIMEOUT");
    return failure("UPSTREAM_ERROR");
  }
}
