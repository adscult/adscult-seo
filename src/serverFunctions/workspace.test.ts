import { beforeEach, expect, it, vi } from "vitest";
import { getWorkspaceMergeStatus, mergeLegacyWorkspaces } from "./workspace";

const mocks = vi.hoisted(() => ({
  context: { role: "member" },
  count: vi.fn(),
  merge: vi.fn(),
}));
vi.mock("cloudflare:workers", () => ({
  env: { AUTH_MODE: "cloudflare_access" },
}));
vi.mock("@/server/auth/workspace-merge", () => ({
  WorkspaceMergeService: {
    countLegacyWorkspaces: mocks.count,
    mergeLegacyWorkspaces: mocks.merge,
  },
}));
vi.mock("@/serverFunctions/middleware", () => ({
  requireAuthenticatedContext: [],
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    middleware: () => ({
      handler:
        (handler: (input: { context: { role: string } }) => unknown) => () =>
          handler({ context: mocks.context }),
    }),
  }),
}));
beforeEach(() => {
  mocks.context.role = "member";
  mocks.count.mockResolvedValue(2);
  mocks.merge.mockResolvedValue({ mergedWorkspaces: 2 });
});

it("blocks members from merging legacy workspaces", async () => {
  await expect(mergeLegacyWorkspaces()).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  expect(mocks.merge).not.toHaveBeenCalled();
});

it.each(["owner", "admin"])(
  "allows %s to merge legacy workspaces",
  async (role) => {
    mocks.context.role = role;
    expect(await getWorkspaceMergeStatus()).toEqual({
      legacyWorkspaceCount: 2,
    });
    expect(await mergeLegacyWorkspaces()).toEqual({ mergedWorkspaces: 2 });
  },
);
