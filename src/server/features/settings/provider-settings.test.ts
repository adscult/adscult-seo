import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { expect, it, vi } from "vitest";
import { ProviderSettingsService } from "./provider-settings";
import { tregAdapter } from "@/server/providers/treg/adapter";
import { resolveProviderExecution } from "@/server/providers/resolver";
import {
  withProviderScope,
  getScopedProviderExecution,
} from "@/server/providers/context";
import { collectMapsTask } from "@/server/providers/local-business";
import { dataforseoPost } from "@/server/lib/dataforseo/core";
import { ProviderRepository } from "@/server/providers/repository";
import { buildCacheKey } from "@/server/lib/r2-cache";

const { client, testDb, databaseProvider, prepareDatabase } = await vi.hoisted(
  () => import("./provider-settings-test-db"),
);
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: testDb }));
vi.mock("@/db/d1/client", () => ({ d1Db: testDb }));
vi.mock("@/db/pg/client", () => ({ pgDb: testDb }));
vi.mock("@/db/provider", () => ({
  getDatabaseProvider: () => databaseProvider,
}));
const admin = { organizationId: "org-a", userId: "admin", role: "admin" };
const otherAdmin = { ...admin, organizationId: "org-b" };
const originalBasic = btoa("original:password");

beforeAll(prepareDatabase);

afterAll(() => client.close());
beforeEach(async () => {
  await client.executeMultiple(
    "DELETE FROM seo_provider_tasks; DELETE FROM seo_provider_tests; DELETE FROM seo_provider_audit_events; DELETE FROM seo_provider_settings; DELETE FROM seo_provider_configurations;",
  );
  vi.stubEnv("DATAFORSEO_API_KEY", originalBasic);
  vi.stubEnv("DATAFORSEO_API_LOGIN", "");
  vi.stubEnv("DATAFORSEO_API_PASSWORD", "");
  vi.stubEnv("SEO_PROVIDER", "");
  vi.stubEnv("SEO_PROVIDER_SECRET_VERSION", "v1");
  vi.stubEnv(
    "SEO_PROVIDER_SECRET_v1",
    "provider-encryption-key-at-least-32-characters",
  );
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({
        status_code: 20000,
        tasks: [{ status_code: 20000, result: [{}] }],
      }),
    ),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function resetWriteLimit() {
  await client.execute(
    "UPDATE seo_provider_settings SET last_action_at = NULL, last_test_at = NULL",
  );
}

async function candidate(
  login = "replacement",
  provider: "dataforseo" | "treg" = "dataforseo",
) {
  return ProviderSettingsService.saveCandidate(admin, {
    provider,
    credentials: {
      action: "replace",
      bundle:
        provider === "treg"
          ? { provider, token: "test-token" }
          : { provider, login, password: "new-password" },
    },
  });
}

async function readyCandidate(
  login?: string,
  provider: "dataforseo" | "treg" = "dataforseo",
) {
  const saved = await candidate(login, provider);
  if (provider === "treg")
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ org_id: 1, org: "test-team" }),
    );
  await ProviderSettingsService.testCandidate(admin, saved.candidateId);
  await resetWriteLimit();
  return saved;
}

it("retains a billed task's cost when configuration persistence fails and never replays its submission", async () => {
  vi.spyOn(ProviderRepository, "saveTasks").mockRejectedValueOnce(
    new Error("database unavailable"),
  );
  vi.mocked(fetch).mockResolvedValueOnce(
    Response.json({
      status_code: 20000,
      tasks: [{ id: "task", status_code: 20100, cost: 0.001 }],
    }),
  );
  await expect(
    withProviderScope(admin.organizationId, () =>
      dataforseoPost("/v3/serp/google/organic/task_post", []),
    ),
  ).rejects.toMatchObject({
    code: "SEO_PROVIDER_CONFIGURATION_UNAVAILABLE",
    billing: { costUsd: 0.001 },
  });
  expect(fetch).toHaveBeenCalledOnce();
});
it("keeps the active override when an inactive candidate asks to use environment credentials", async () => {
  const active = await readyCandidate("active");
  await ProviderSettingsService.activate(admin, active.candidateId, 0);
  await resetWriteLimit();
  await ProviderSettingsService.saveCandidate(admin, {
    provider: "dataforseo",
    credentials: { action: "environment" },
  });
  await resetWriteLimit();
  const unchanged = await ProviderSettingsService.saveCandidate(admin, {
    provider: "dataforseo",
    credentials: { action: "unchanged" },
  });
  expect(
    await resolveProviderExecution(admin.organizationId, unchanged.candidateId),
  ).toMatchObject({ authorization: btoa("active:new-password") });
});
it("fails closed when shared settings cannot be read", async () => {
  vi.spyOn(ProviderRepository, "settings").mockRejectedValueOnce(
    new Error("database unavailable"),
  );
  await expect(
    resolveProviderExecution(admin.organizationId),
  ).rejects.toMatchObject({ code: "SEO_PROVIDER_CONFIGURATION_UNAVAILABLE" });
  expect(fetch).not.toHaveBeenCalled();
});

it("separates cached results by organization and committed provider revision", async () => {
  const key = () => buildCacheKey("serp.live", { keyword: "coffee" });
  const original = await withProviderScope(admin.organizationId, key);
  const foreign = await withProviderScope(otherAdmin.organizationId, key);
  const saved = await readyCandidate();
  await ProviderSettingsService.activate(admin, saved.candidateId, 0);
  expect(await withProviderScope(admin.organizationId, key)).not.toBe(original);
  expect(foreign).not.toBe(original);
});

it("keeps older encrypted versions readable after encryption-key rotation", async () => {
  const first = await candidate("first");
  await resetWriteLimit();
  vi.stubEnv("SEO_PROVIDER_SECRET_VERSION", "v2");
  vi.stubEnv(
    "SEO_PROVIDER_SECRET_v2",
    "second-encryption-key-at-least-32-characters",
  );
  const second = await candidate("second");
  expect(
    await resolveProviderExecution(admin.organizationId, first.candidateId),
  ).toMatchObject({ authorization: btoa("first:new-password") });
  expect(
    await resolveProviderExecution(admin.organizationId, second.candidateId),
  ).toMatchObject({ authorization: btoa("second:new-password") });
  vi.stubEnv("SEO_PROVIDER_SECRET_v1", "");
  await expect(
    resolveProviderExecution(admin.organizationId, first.candidateId),
  ).rejects.toMatchObject({ code: "SEO_PROVIDER_NOT_CONFIGURED" });
});
it("preserves the environment default and rejects invalid selection or missing credentials without fallback", async () => {
  expect(await resolveProviderExecution(admin.organizationId)).toMatchObject({
    provider: "dataforseo",
    revision: 0,
    source: "environment",
    authorization: originalBasic,
  });
  vi.stubEnv("SEO_PROVIDER", "unknown");
  await expect(
    resolveProviderExecution(admin.organizationId),
  ).rejects.toMatchObject({ code: "SEO_PROVIDER_NOT_CONFIGURED" });
  vi.stubEnv("SEO_PROVIDER", "treg");
  vi.stubEnv("TREG_TOKEN", "");
  await expect(
    resolveProviderExecution(admin.organizationId),
  ).rejects.toMatchObject({ code: "SEO_PROVIDER_NOT_CONFIGURED" });
});

it("encrypts replacements and never returns saved credentials to the browser", async () => {
  const saved = await candidate();
  const row = await client.execute("SELECT * FROM seo_provider_configurations");
  expect(row.rows[0].encrypted_credentials).not.toContain("new-password");
  expect(row.rows[0].key_version).toBe("v1");
  expect(
    await resolveProviderExecution(admin.organizationId, saved.candidateId),
  ).toMatchObject({ authorization: btoa("replacement:new-password") });
  const browserState = JSON.stringify(
    await ProviderSettingsService.read(admin),
  );
  expect(browserState).not.toContain("encryptedCredentials");
  expect(browserState).not.toContain("new-password");
  expect(await resolveProviderExecution(admin.organizationId)).toMatchObject({
    authorization: originalBasic,
  });
});

it("denies every settings operation to members and isolates candidates across organizations", async () => {
  const member = { ...admin, role: "member" };
  const denied = [
    () => ProviderSettingsService.read(member),
    () =>
      ProviderSettingsService.saveCandidate(member, {
        provider: "dataforseo",
        credentials: { action: "environment" },
      }),
    () => ProviderSettingsService.testCandidate(member, crypto.randomUUID()),
    () => ProviderSettingsService.activate(member, crypto.randomUUID(), 0),
  ];
  for (const operation of denied)
    await expect(operation()).rejects.toMatchObject({ code: "FORBIDDEN" });
  const saved = await candidate();
  await expect(
    ProviderSettingsService.testCandidate(otherAdmin, saved.candidateId),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect((await ProviderSettingsService.read(otherAdmin)).history).toHaveLength(
    0,
  );
});

it.each(["dataforseo", "treg"] as const)(
  "activates %s as one audited revision and refuses a stale administrator",
  async (provider) => {
    const saved = await readyCandidate(undefined, provider);
    await ProviderSettingsService.activate(admin, saved.candidateId, 0);
    await resetWriteLimit();
    await expect(
      ProviderSettingsService.activate(admin, saved.candidateId, 0),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await ProviderSettingsService.read(admin)).toMatchObject({
      revision: 1,
      provider,
    });
  },
);

it("allows only one concurrent activation and writes only the winning audit event", async () => {
  const saved = await readyCandidate();
  // Exercise the atomic persistence boundary directly: the service's write
  // throttle can reject the second administrator before it reaches CAS.
  const input = {
    organizationId: admin.organizationId,
    actor: admin.userId,
    configurationId: saved.candidateId,
    previousConfigurationId: null,
    expectedRevision: 0,
  };
  const outcomes = await Promise.allSettled([
    ProviderRepository.activate(input),
    ProviderRepository.activate({ ...input, actor: "other-admin" }),
  ]);
  expect(
    outcomes.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(outcomes.find((result) => result.status === "rejected")).toMatchObject(
    { reason: { code: "CONFLICT" } },
  );
  expect(await ProviderSettingsService.read(admin)).toMatchObject({
    revision: 1,
    activeConfigurationId: saved.candidateId,
  });
  const events = await client.execute(
    "SELECT revision FROM seo_provider_audit_events WHERE action = 'activate'",
  );
  expect(events.rows).toEqual([{ revision: 1 }]);
});

it("keeps the resolved request immutable while another request sees activation", async () => {
  const saved = await readyCandidate();
  await withProviderScope(admin.organizationId, async () => {
    const original = await getScopedProviderExecution();
    await ProviderSettingsService.activate(admin, saved.candidateId, 0);
    expect(await getScopedProviderExecution()).toBe(original);
  });
  await withProviderScope(admin.organizationId, async () => {
    expect(await getScopedProviderExecution()).toMatchObject({
      revision: 1,
      authorization: btoa("replacement:new-password"),
    });
  });
});

it("requires a fresh test of the exact environment credential", async () => {
  const saved = await ProviderSettingsService.saveCandidate(admin, {
    provider: "dataforseo",
    credentials: { action: "environment" },
  });
  await ProviderSettingsService.testCandidate(admin, saved.candidateId);
  vi.stubEnv("DATAFORSEO_API_KEY", btoa("changed:password"));
  await resetWriteLimit();
  await expect(
    ProviderSettingsService.activate(admin, saved.candidateId, 0),
  ).rejects.toMatchObject({ code: "CONFLICT" });
});

it("does not mark HTTP 200 with a failed vendor task as ready", async () => {
  const saved = await candidate();
  vi.mocked(fetch).mockResolvedValue(
    Response.json({
      status_code: 20000,
      tasks: [{ status_code: 40100, result: null }],
    }),
  );
  expect(
    await ProviderSettingsService.testCandidate(admin, saved.candidateId),
  ).toMatchObject({ ready: false, result: { ok: false } });
  await resetWriteLimit();
  await expect(
    ProviderSettingsService.activate(admin, saved.candidateId, 0),
  ).rejects.toMatchObject({ code: "CONFLICT" });
});

it("keeps unverified required operations disabled after authentication", async () => {
  const capabilities = tregAdapter.capabilities();
  vi.spyOn(tregAdapter, "capabilities").mockReturnValue(
    capabilities.map((item) =>
      item.operation === "serp.live" ? { ...item, state: "unverified" } : item,
    ),
  );
  vi.mocked(fetch).mockResolvedValueOnce(
    Response.json({ org_id: 1, org: "test-team" }),
  );
  const saved = await candidate(undefined, "treg");
  expect(
    await ProviderSettingsService.testCandidate(admin, saved.candidateId),
  ).toMatchObject({
    ready: false,
    outcome: "unverified",
    authentication: "passed",
  });
  await resetWriteLimit();
  await expect(
    ProviderSettingsService.activate(admin, saved.candidateId, 0),
  ).rejects.toMatchObject({ code: "SEO_PROVIDER_UNSUPPORTED" });
});

it("rolls back to a retained credential and removes an override only through tested environment activation", async () => {
  const first = await readyCandidate("first");
  await ProviderSettingsService.activate(admin, first.candidateId, 0);
  await resetWriteLimit();
  const second = await readyCandidate("second");
  await ProviderSettingsService.activate(admin, second.candidateId, 1);
  await resetWriteLimit();
  await ProviderSettingsService.testCandidate(admin, first.candidateId);
  await ProviderSettingsService.activate(admin, first.candidateId, 2);
  expect(await resolveProviderExecution(admin.organizationId)).toMatchObject({
    revision: 3,
    authorization: btoa("first:new-password"),
  });
  await resetWriteLimit();
  const environment = await ProviderSettingsService.saveCandidate(admin, {
    provider: "dataforseo",
    selection: "environment",
    credentials: { action: "environment" },
  });
  await ProviderSettingsService.testCandidate(admin, environment.candidateId);
  await resetWriteLimit();
  await ProviderSettingsService.activate(admin, environment.candidateId, 3);
  expect(await resolveProviderExecution(admin.organizationId)).toMatchObject({
    revision: 4,
    source: "environment",
    authorization: originalBasic,
  });
});

it("polls a queued task through its original credential after switching and rejects cross-organization polling", async () => {
  const first = await readyCandidate("task-owner");
  await ProviderSettingsService.activate(admin, first.candidateId, 0);
  vi.mocked(fetch).mockResolvedValueOnce(
    Response.json({
      status_code: 20000,
      tasks: [
        {
          id: "queued-task",
          status_code: 20100,
          path: ["v3", "serp", "google", "maps", "task_post"],
          cost: 0.001,
        },
      ],
    }),
  );
  await withProviderScope(admin.organizationId, () =>
    dataforseoPost("/v3/serp/google/maps/task_post", []),
  );
  await resetWriteLimit();
  const second = await readyCandidate("new-owner");
  await ProviderSettingsService.activate(admin, second.candidateId, 1);
  const collected = await withProviderScope(admin.organizationId, () =>
    collectMapsTask(
      { ...admin, userEmail: "admin@example.com" },
      "queued-task",
    ),
  );
  expect(collected.meta).toMatchObject({
    provider: "dataforseo",
    settingsRevision: 1,
  });
  const headers = new Headers(vi.mocked(fetch).mock.lastCall?.[1]?.headers);
  expect(headers.get("Authorization")).toBe(
    `Basic ${btoa("task-owner:new-password")}`,
  );
  await withProviderScope(otherAdmin.organizationId, async () => {
    await expect(
      collectMapsTask(
        { ...otherAdmin, userEmail: "other@example.com" },
        "queued-task",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
