import { getAuthMode } from "@/lib/auth-mode";
import { hasOrgPermission } from "@/lib/org-permissions";
import { requireOrgPermission } from "@/server/auth/org-gate";
import { AuthRepository } from "@/server/auth/repositories/AuthRepository";
import { SelfhostTeamRepository } from "@/server/auth/repositories/SelfhostTeamRepository";
import { SHARED_WORKSPACE_ORGANIZATION_ID } from "@/server/auth/delegated-organization";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { AppError } from "@/server/lib/errors";
import type { EnsuredUserContext } from "@/middleware/ensure-user/types";
import {
  selfhostOwnerEmailsSchema,
  selfhostTeamRoleSchema,
  updateSelfhostTeamRoleSchema,
} from "@/shared/selfhost-team";
import type { z } from "zod";

type Context = Pick<EnsuredUserContext, "organizationId" | "userId" | "role">;

async function ownerEmails() {
  const parsed = selfhostOwnerEmailsSchema.safeParse(
    await getOptionalEnvValue("SELFHOST_OWNER_EMAILS"),
  );
  if (!parsed.success) {
    throw new AppError(
      "AUTH_CONFIG_MISSING",
      "Set SELFHOST_OWNER_EMAILS to a comma-separated list of owner email addresses.",
    );
  }
  return parsed.data;
}

function effectiveRole(
  email: string,
  storedRole: string,
  owners: string[],
): "owner" | "admin" | "member" {
  if (owners.includes(email.trim().toLowerCase())) return "owner";
  // An old owner row cannot retain ownership after the operator removes them.
  return selfhostTeamRoleSchema.safeParse(storedRole).data ?? "member";
}

async function requireSharedWorkspace(context: Context) {
  if (
    getAuthMode(await getOptionalEnvValue("AUTH_MODE")) !==
      "cloudflare_access" ||
    context.organizationId !== SHARED_WORKSPACE_ORGANIZATION_ID
  ) {
    throw new AppError("FORBIDDEN");
  }
}

async function getRole(userId: string, email: string) {
  const owners = await ownerEmails();
  const membership = await AuthRepository.getMembership(
    userId,
    SHARED_WORKSPACE_ORGANIZATION_ID,
  );
  if (!membership) throw new AppError("FORBIDDEN");
  return effectiveRole(email, membership.role, owners);
}

async function join(userId: string, email: string) {
  // Fail before inserting anything if ownership has not been configured.
  await ownerEmails();
  await SelfhostTeamRepository.ensureMember(
    SHARED_WORKSPACE_ORGANIZATION_ID,
    userId,
  );
  return getRole(userId, email);
}

async function list(context: Context) {
  await requireSharedWorkspace(context);
  const owners = await ownerEmails();
  const members = await SelfhostTeamRepository.list(context.organizationId);
  return {
    userId: context.userId,
    canManage: hasOrgPermission(context.role, { member: ["update"] }),
    members: members.map((row) => ({
      ...row,
      role: effectiveRole(row.email, row.role, owners),
    })),
  };
}

async function updateRole(
  context: Context,
  input: z.input<typeof updateSelfhostTeamRoleSchema>,
) {
  await requireSharedWorkspace(context);
  requireOrgPermission(context, { member: ["update"] });
  const data = updateSelfhostTeamRoleSchema.parse(input);
  const owners = await ownerEmails();
  const members = await SelfhostTeamRepository.list(context.organizationId);
  const target = members.find((row) => row.id === data.memberId);
  if (!target) throw new AppError("NOT_FOUND");
  if (
    target.userId === context.userId ||
    effectiveRole(target.email, target.role, owners) === "owner"
  ) {
    throw new AppError(
      "FORBIDDEN",
      "Owner accounts and your own role cannot be changed here.",
    );
  }
  const updated = await SelfhostTeamRepository.updateRole(
    context.organizationId,
    target.id,
    data.role,
  );
  if (!updated.length) throw new AppError("NOT_FOUND");
  return { memberId: target.id, role: data.role };
}

export const SelfhostTeamService = { join, getRole, list, updateRole };
