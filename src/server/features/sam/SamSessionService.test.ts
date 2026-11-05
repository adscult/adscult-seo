import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { SamSessionService } from "./SamSessionService";
import { SamSessionRepository } from "./SamSessionRepository";
import { SamUsageRepository } from "./SamUsageRepository";

const runtime = vi.hoisted(() => ({
  database: null as unknown,
  erase: vi.fn<(id: string) => Promise<void>>(),
  project:
    vi.fn<
      (
        projectId: string,
        organizationId: string,
      ) => Promise<{ id: string } | null>
    >(),
}));
vi.mock("@/db", () => ({
  get db() {
    return runtime.database;
  },
}));
vi.mock("@/db/schema", async () => await import("@/db/sam.schema"));
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: { getProjectForOrganization: runtime.project },
}));
vi.mock("cloudflare:workers", () => ({
  env: {
    SAM_CHAT: {
      idFromName: (id: string) => id,
      get: (id: string) => ({ destroyForErasure: () => runtime.erase(id) }),
    },
  },
}));
const client = createClient({ url: "file::memory:" });
const input = { sessionId: "chat", userId: "alice", organizationId: "team" };
beforeAll(async () => {
  runtime.database = drizzle(client);
  await client.executeMultiple(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organization (id text PRIMARY KEY);
    INSERT INTO organization VALUES ('team');
    CREATE TABLE sam_sessions (id text PRIMARY KEY, project_id text NOT NULL, user_id text NOT NULL, title text NOT NULL DEFAULT 'New chat', created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP, archived_at text);
  `);
  await client.executeMultiple(
    readFileSync("drizzle/sqlite/0060_spooky_plazm.sql", "utf8").replaceAll(
      "--> statement-breakpoint",
      "",
    ),
  );
});
beforeEach(async () => {
  runtime.erase.mockResolvedValue(undefined);
  runtime.project.mockImplementation(async (projectId, organizationId) =>
    organizationId === "team" ? { id: projectId } : null,
  );
  await client.executeMultiple(`DELETE FROM sam_model_calls; DELETE FROM sam_usage_days; DELETE FROM sam_sessions;
    INSERT INTO sam_sessions (id, project_id, user_id) VALUES ('chat', 'project', 'alice'), ('other-chat', 'project', 'bob');`);
});
afterAll(() => client.close());

it("erases only the owner's conversation while preserving recorded team usage", async () => {
  const call = await SamUsageRepository.admit({
    organizationId: "team",
    sessionId: "chat",
    provider: "anthropic",
    model: "fixture-model",
    purpose: "response",
  });
  await SamUsageRepository.finish(call, {
    inputTokens: { total: 100 },
    outputTokens: { total: 20 },
  });
  await SamSessionService.deleteSession(input);
  expect(runtime.erase).toHaveBeenCalledExactlyOnceWith("chat");
  expect(await SamSessionRepository.getSessionById("chat")).toBeNull();
  expect(
    await SamSessionRepository.getActiveSession("other-chat", "bob"),
  ).not.toBeNull();
  expect(await SamUsageRepository.status("team")).toMatchObject({
    tokens: 120,
  });
  expect(
    (await client.execute("SELECT session_id FROM sam_model_calls")).rows[0]
      .session_id,
  ).toBeNull();
});

it.each([
  { userId: "bob" },
  { organizationId: "another-team" },
  { sessionId: "missing" },
])(
  "refuses deletion of an inaccessible conversation (%j)",
  async (override) => {
    await expect(
      SamSessionService.deleteSession({ ...input, ...override }),
    ).rejects.toThrow("Chat session not found");
    expect(runtime.erase).not.toHaveBeenCalled();
    expect(
      await SamSessionRepository.getActiveSession("chat", "alice"),
    ).not.toBeNull();
  },
);

it("keeps the conversation available for retry when transcript erasure fails", async () => {
  runtime.erase.mockRejectedValueOnce(new Error("Transcript unavailable"));
  await expect(SamSessionService.deleteSession(input)).rejects.toThrow(
    "Transcript unavailable",
  );
  expect(
    await SamSessionRepository.getActiveSession("chat", "alice"),
  ).not.toBeNull();
  await SamSessionService.deleteSession(input);
  expect(await SamSessionRepository.getSessionById("chat")).toBeNull();
});
