import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { SamUsageRepository } from "./SamUsageRepository";

const runtime = vi.hoisted(() => ({ database: null as unknown }));
vi.mock("@/db", () => ({
  get db() {
    return runtime.database;
  },
}));
vi.mock("@/db/schema", async () => await import("@/db/sam.schema"));

const client = createClient({ url: "file::memory:" });
const database = drizzle(client);

beforeAll(async () => {
  runtime.database = database;
  await client.executeMultiple(`
    CREATE TABLE organization (id text PRIMARY KEY);
    CREATE TABLE sam_sessions (id text PRIMARY KEY);
    INSERT INTO organization VALUES ('team'), ('other');
    INSERT INTO sam_sessions VALUES ('alice-project-a'), ('bob-project-b');
  `);
  await client.executeMultiple(
    readFileSync("drizzle/sqlite/0060_spooky_plazm.sql", "utf8").replaceAll(
      "--> statement-breakpoint",
      "",
    ),
  );
});
beforeEach(async () => {
  await client.execute("DELETE FROM sam_model_calls");
  await client.execute("DELETE FROM sam_usage_days");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-04T18:29:59Z"));
});
afterEach(() => vi.useRealTimers());
afterAll(() => client.close());

const admit = (sessionId = "alice-project-a", organizationId = "team") =>
  SamUsageRepository.admit({
    sessionId,
    organizationId,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    purpose: "response",
  });
const usage = (input: number, output = 0) => ({
  inputTokens: { total: input },
  outputTokens: { total: output },
});

it("shares usage across users and projects, isolates organizations, and records usage once", async () => {
  const alice = await admit();
  const bob = await admit("bob-project-b");
  await SamUsageRepository.finish(alice, usage(500, 100));
  await SamUsageRepository.finish(alice, usage(500, 100));
  await SamUsageRepository.finish(bob, usage(700, 50));
  expect(await SamUsageRepository.status("team")).toMatchObject({
    tokens: 1350,
    allowance: 1_000_000,
    resetAt: "2026-11-04T18:30:00.000Z",
  });
  expect(await SamUsageRepository.status("other")).toMatchObject({ tokens: 0 });
});

it("allows admitted calls to finish over the threshold and blocks the next step", async () => {
  const first = await admit();
  const second = await admit("bob-project-b");
  await SamUsageRepository.finish(first, usage(999_000, 1000));
  await SamUsageRepository.finish(second, usage(2000));
  expect(await SamUsageRepository.status("team")).toMatchObject({
    tokens: 1_002_000,
  });
  await expect(admit()).rejects.toThrow("daily token allowance is exhausted");
});

it("resets at Kolkata midnight and assigns a spanning call to its admission day", async () => {
  const yesterday = await admit();
  vi.setSystemTime(new Date("2026-11-04T18:30:00Z"));
  await SamUsageRepository.finish(yesterday, usage(1_000_000));
  expect(await SamUsageRepository.status("team")).toMatchObject({
    date: "2026-11-05",
    tokens: 0,
    resetAt: "2026-11-05T18:30:00.000Z",
  });
  await expect(admit()).resolves.toEqual(expect.any(String));
});

it("keeps interrupted calls visible without inventing provider usage", async () => {
  const id = await admit();
  await SamUsageRepository.finish(id);
  expect(await SamUsageRepository.status("team")).toMatchObject({ tokens: 0 });
  const row = await client.execute({
    sql: "SELECT status FROM sam_model_calls WHERE id = ?",
    args: [id],
  });
  expect(row.rows[0]?.status).toBe("interrupted");
});
