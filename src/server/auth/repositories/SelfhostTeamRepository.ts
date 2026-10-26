import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { member, user } from "@/db/schema";

async function ensureMember(organizationId: string, userId: string) {
  await db
    .insert(member)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      userId,
      role: "member",
      createdAt: new Date(),
    })
    .onConflictDoNothing({ target: [member.organizationId, member.userId] });
}

async function list(organizationId: string) {
  return db
    .select({
      id: member.id,
      userId: member.userId,
      role: member.role,
      name: user.name,
      email: user.email,
    })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(eq(member.organizationId, organizationId))
    .orderBy(asc(user.email));
}

async function updateRole(
  organizationId: string,
  memberId: string,
  role: "admin" | "member",
) {
  return db
    .update(member)
    .set({ role })
    .where(
      and(eq(member.organizationId, organizationId), eq(member.id, memberId)),
    )
    .returning({ id: member.id });
}

export const SelfhostTeamRepository = { ensureMember, list, updateRole };
