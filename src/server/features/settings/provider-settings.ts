import type { z } from "zod";
import type { EnsuredUserContext } from "@/middleware/ensure-user/types";
import { requireOrgPermission } from "@/server/auth/org-gate";
import { ProviderRepository } from "@/server/providers/repository";
import { resolveProviderExecution } from "@/server/providers/resolver";
import { getProviderAdapter } from "@/server/providers/registry";
import type { ProviderExecution } from "@/server/providers/types";
import {
  credentialDigest,
  encodeBasicCredentials,
  sealProviderCredentials,
} from "@/server/providers/credentials";
import {
  getOptionalEnvValue,
  isHostedServerAuthMode,
} from "@/server/lib/runtime-env";
import { AppError } from "@/server/lib/errors";
import {
  providerCandidateSchema,
  seoProviderIdSchema,
  type SeoProviderId,
} from "@/types/schemas/seo-provider";

type Context = Pick<EnsuredUserContext, "organizationId" | "userId" | "role">;
const authorize = (context: Context) =>
  requireOrgPermission(context, { integration: ["manage"] });

// Search results and keyword metrics are required for the initial switch.
// Other operations remain independently represented in the feature matrix.
const requiredOperations = ["serp.live", "keywords.overview"];
function readiness(provider: SeoProviderId) {
  const capabilities = getProviderAdapter(provider).capabilities();
  return {
    capabilities,
    requiredOperations,
    ready: requiredOperations.every((operation) =>
      capabilities.some(
        (item) => item.operation === operation && item.state === "available",
      ),
    ),
  };
}

function testFingerprint(execution: ProviderExecution) {
  return credentialDigest(
    JSON.stringify({
      authorization: execution.authorization,
      contractVersion: 1,
      ...readiness(execution.provider),
    }),
  );
}

async function environmentProvider() {
  const parsed = seoProviderIdSchema.safeParse(
    (await getOptionalEnvValue("SEO_PROVIDER")) ?? "dataforseo",
  );
  if (!parsed.success) throw new AppError("SEO_PROVIDER_NOT_CONFIGURED");
  return parsed.data;
}

async function read(context: Context) {
  authorize(context);
  const setting = await ProviderRepository.settings(context.organizationId);
  const history = await ProviderRepository.history(context.organizationId);
  const lastTest = setting?.activeConfigurationId
    ? await ProviderRepository.latestTest(
        context.organizationId,
        setting.activeConfigurationId,
      )
    : undefined;
  let provider: SeoProviderId | null = null;
  let configured = false;
  let credentialSource: "database" | "environment" | null = null;
  let operationalError: string | null = null;
  try {
    const execution = await resolveProviderExecution(context.organizationId);
    provider = execution.provider;
    credentialSource = execution.source;
    configured = true;
  } catch (error) {
    operationalError =
      error instanceof AppError
        ? error.code
        : "SEO_PROVIDER_CONFIGURATION_UNAVAILABLE";
    const config = setting?.activeConfigurationId
      ? await ProviderRepository.configuration(
          context.organizationId,
          setting.activeConfigurationId,
        )
      : undefined;
    const selected = seoProviderIdSchema.safeParse(
      config?.provider ??
        (await getOptionalEnvValue("SEO_PROVIDER")) ??
        "dataforseo",
    );
    provider = selected.success ? selected.data : null;
  }
  return {
    provider,
    configured,
    credentialSource,
    operationalError,
    selectionSource: setting?.activeConfigurationId
      ? "database"
      : "environment",
    activeConfigurationId: setting?.activeConfigurationId ?? null,
    revision: setting?.revision ?? 0,
    capabilities: provider ? getProviderAdapter(provider).capabilities() : [],
    requiredOperations,
    lastTest: lastTest
      ? { outcome: lastTest.outcome, testedAt: lastTest.testedAt }
      : null,
    history,
  };
}

async function saveCandidate(
  context: Context,
  input: z.input<typeof providerCandidateSchema>,
) {
  authorize(context);
  const data = providerCandidateSchema.parse(input);
  await ProviderRepository.rateLimit(context.organizationId, 2_000);
  const provider =
    data.selection === "environment"
      ? await environmentProvider()
      : data.provider;
  let sealed: {
    encryptedCredentials: string | null;
    keyVersion: string | null;
  } = { encryptedCredentials: null, keyVersion: null };
  let credentialSource: "database" | "environment" = "environment";
  if (
    data.selection === "environment" &&
    data.credentials.action !== "environment"
  )
    throw new AppError("VALIDATION_ERROR");
  if (data.credentials.action === "replace") {
    if (data.credentials.bundle.provider !== provider)
      throw new AppError("VALIDATION_ERROR");
    const bundle = data.credentials.bundle;
    sealed = await sealProviderCredentials(
      bundle.provider === "dataforseo"
        ? encodeBasicCredentials(bundle.login, bundle.password)
        : bundle.token,
    );
    credentialSource = "database";
  } else if (data.credentials.action === "unchanged") {
    const setting = await ProviderRepository.settings(context.organizationId);
    if (setting?.activeConfigurationId) {
      const configuration = await ProviderRepository.configuration(
        context.organizationId,
        setting.activeConfigurationId,
      );
      if (!configuration) throw new AppError("CONFLICT");
      if (
        configuration.provider === provider &&
        configuration.credentialSource === "database"
      ) {
        sealed = {
          encryptedCredentials: configuration.encryptedCredentials,
          keyVersion: configuration.keyVersion,
        };
        credentialSource = "database";
      }
    }
  }
  const id = crypto.randomUUID();
  await ProviderRepository.saveCandidate({
    id,
    organizationId: context.organizationId,
    provider,
    selectionSource: data.selection,
    credentialSource,
    ...sealed,
    createdBy: context.userId,
    createdAt: new Date().toISOString(),
  });
  return {
    candidateId: id,
    provider,
    credentialSource,
    capabilities: getProviderAdapter(provider).capabilities(),
    chargeNotice:
      "Connection testing is free. It checks authentication; it does not run paid SEO operations.",
  };
}

async function testCandidate(context: Context, candidateId: string) {
  authorize(context);
  await ProviderRepository.rateLimit(context.organizationId, 10_000, "test");
  const configuration = await ProviderRepository.configuration(
    context.organizationId,
    candidateId,
  );
  if (!configuration) throw new AppError("NOT_FOUND");
  const adapter = getProviderAdapter(configuration.provider);
  const execution = await resolveProviderExecution(
    context.organizationId,
    candidateId,
  );
  const result = await adapter.testConnection(execution);
  const availability = readiness(execution.provider);
  const testedAt = result.meta.fetchedAt;
  const outcome = result.ok
    ? availability.ready
      ? "ready"
      : "unverified"
    : result.error.code === "UNSUPPORTED"
      ? "unverified"
      : result.error.code.toLowerCase();
  await ProviderRepository.recordTest(
    {
      id: crypto.randomUUID(),
      organizationId: context.organizationId,
      configurationId: candidateId,
      credentialDigest: await testFingerprint(execution),
      outcome,
      testedAt,
    },
    context.userId,
  );
  return {
    result,
    outcome,
    testedAt,
    authentication: result.ok ? "passed" : outcome,
    ready: result.ok && availability.ready,
    requiredOperations,
    capabilities: adapter.capabilities(),
  };
}

async function activate(
  context: Context,
  candidateId: string,
  expectedRevision: number,
) {
  authorize(context);
  await ProviderRepository.rateLimit(context.organizationId, 2_000);
  const configuration = await ProviderRepository.configuration(
    context.organizationId,
    candidateId,
  );
  if (!configuration) throw new AppError("NOT_FOUND");
  const execution = await resolveProviderExecution(
    context.organizationId,
    candidateId,
  );
  // Require verified operation contracts, including after an adapter upgrade.
  // Hosted Treg resale needs separate receipt/reservation billing verification.
  if (
    !readiness(execution.provider).ready ||
    (execution.provider === "treg" && (await isHostedServerAuthMode()))
  )
    throw new AppError("SEO_PROVIDER_UNSUPPORTED");
  const test = await ProviderRepository.latestTest(
    context.organizationId,
    candidateId,
  );
  if (
    !test ||
    test.outcome !== "ready" ||
    Date.now() - Date.parse(test.testedAt) > 15 * 60_000 ||
    !readiness(execution.provider).ready ||
    test.credentialDigest !== (await testFingerprint(execution))
  )
    throw new AppError("CONFLICT");
  if (
    configuration.selectionSource === "environment" &&
    (await environmentProvider()) !== execution.provider
  )
    throw new AppError("CONFLICT");
  const setting = await ProviderRepository.settings(context.organizationId);
  await ProviderRepository.activate({
    organizationId: context.organizationId,
    actor: context.userId,
    configurationId:
      configuration.selectionSource === "environment" ? null : candidateId,
    previousConfigurationId: setting?.activeConfigurationId ?? null,
    expectedRevision,
  });
  return { revision: expectedRevision + 1 };
}

export const ProviderSettingsService = {
  read,
  saveCandidate,
  testCandidate,
  activate,
};
