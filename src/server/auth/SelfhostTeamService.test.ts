import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { resolveSharedWorkspaceContext } from "@/middleware/ensure-user/delegated";
import { SelfhostTeamService } from "./SelfhostTeamService";
import type { EnsuredUserContext } from "@/middleware/ensure-user/types";
import { resolveSamToolRole } from "@/server/features/sam/samToolAuth";

const { client, testDb } = await vi.hoisted(async () => {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  const schema = await import("@/db/better-auth-schema");
  const connection = createClient({ url: "file::memory:" });
  return { client: connection, testDb: drizzle(connection, { schema }) };
});
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: testDb }));
vi.mock("@/db/d1/client", () => ({ d1Db: testDb }));
vi.mock("@/db/pg/client", () => ({ pgDb: null }));

let owner: EnsuredUserContext;
let member: EnsuredUserContext;

beforeAll(async () => {
  await client.executeMultiple(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE organization (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE, logo TEXT, created_at INTEGER, metadata TEXT);
    CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, email_verified INTEGER, image TEXT, created_at INTEGER, updated_at INTEGER, analytics_opted_out INTEGER, last_active_organization_id TEXT);
    CREATE TABLE member (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organization(id), user_id TEXT NOT NULL REFERENCES user(id), role TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (organization_id, user_id));
  `);
});
afterAll(() => client.close());
afterEach(() => vi.unstubAllEnvs());
beforeEach(async () => {
  vi.stubEnv("AUTH_MODE", "cloudflare_access");
  vi.stubEnv("SELFHOST_OWNER_EMAILS", " Owner@Example.com ");
  await client.executeMultiple(
    "DELETE FROM member; DELETE FROM user; DELETE FROM organization;",
  );
  owner = await resolveSharedWorkspaceContext("owner", "owner@example.com");
  member = await resolveSharedWorkspaceContext(
    "analyst",
    "analyst@example.com",
  );
});

async function memberId(userId: string) {
  const team = await SelfhostTeamService.list(owner);
  return team.members.find((person) => person.userId === userId)!.id;
}

it("gives only configured identities ownership and defaults new Access users to members", async () => {
  expect(owner.role).toBe("owner");
  expect(member.role).toBe("member");
  expect((await SelfhostTeamService.list(member)).canManage).toBe(false);
});

it("preserves an assigned admin role on later and concurrent sign-ins, and applies demotion on the next request", async () => {
  const id = await memberId(member.userId);
  await SelfhostTeamService.updateRole(owner, { memberId: id, role: "admin" });
  const signIns = await Promise.all([
    resolveSharedWorkspaceContext(member.userId, member.userEmail),
    resolveSharedWorkspaceContext(member.userId, member.userEmail),
  ]);
  expect(signIns.map((person) => person.role)).toEqual(["admin", "admin"]);
  await SelfhostTeamService.updateRole(owner, { memberId: id, role: "member" });
  await expect(resolveSamToolRole(member)).resolves.toBe("member");
  expect((await SelfhostTeamService.list(owner)).members).toHaveLength(2);
});

it("denies role changes by ordinary members", async () => {
  await expect(
    SelfhostTeamService.updateRole(member, {
      memberId: await memberId(owner.userId),
      role: "admin",
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});

it("lets admins manage other members but protects configured owners and their own role", async () => {
  await SelfhostTeamService.updateRole(owner, {
    memberId: await memberId(member.userId),
    role: "admin",
  });
  const admin = await resolveSharedWorkspaceContext(
    member.userId,
    member.userEmail,
  );
  const colleague = await resolveSharedWorkspaceContext(
    "colleague",
    "colleague@example.com",
  );
  await SelfhostTeamService.updateRole(admin, {
    memberId: await memberId(colleague.userId),
    role: "admin",
  });
  await expect(
    SelfhostTeamService.getRole(colleague.userId, colleague.userEmail),
  ).resolves.toBe("admin");
  for (const target of [owner, admin]) {
    await expect(
      SelfhostTeamService.updateRole(admin, {
        memberId: await memberId(target.userId),
        role: "member",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  }
});

it("removes owner privileges when the operator changes owner configuration", async () => {
  vi.stubEnv("SELFHOST_OWNER_EMAILS", member.userEmail);
  await expect(
    SelfhostTeamService.getRole(owner.userId, owner.userEmail),
  ).resolves.toBe("member");
  await expect(
    SelfhostTeamService.getRole(member.userId, member.userEmail),
  ).resolves.toBe("owner");
});

it("rejects a role change targeting a membership in another organization", async () => {
  await client.executeMultiple(
    "INSERT INTO organization (id, name, slug) VALUES ('foreign', 'Other team', 'other'); INSERT INTO member VALUES ('foreign-member', 'foreign', 'analyst', 'member', 0);",
  );
  await expect(
    SelfhostTeamService.updateRole(owner, {
      memberId: "foreign-member",
      role: "admin",
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

it.each(["local_noauth", "hosted"])(
  "does not expose Access team management in %s mode",
  async (mode) => {
    vi.stubEnv("AUTH_MODE", mode);
    await expect(SelfhostTeamService.list(owner)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  },
);

it("fails closed when no owner is configured", async () => {
  vi.stubEnv("SELFHOST_OWNER_EMAILS", "");
  await expect(
    resolveSharedWorkspaceContext("new-user", "new@example.com"),
  ).rejects.toMatchObject({ code: "AUTH_CONFIG_MISSING" });
});

it("revokes SAM tools when a hosted user's membership has been removed", async () => {
  vi.stubEnv("AUTH_MODE", "hosted");
  await client.execute("DELETE FROM member WHERE user_id = 'analyst'");
  await expect(resolveSamToolRole(member)).resolves.toBeNull();
});

it("does not apply shared-workspace SAM roles to another organization's chat", async () => {
  await expect(
    resolveSamToolRole({ ...owner, organizationId: "foreign" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});
