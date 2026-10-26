import { z } from "zod";

// Owner identities come from operator configuration, never first-login order.
export const selfhostOwnerEmailsSchema = z
  .string()
  .transform((value) =>
    value.split(",").map((email) => email.trim().toLowerCase()),
  )
  .pipe(z.array(z.email()).min(1));

export const selfhostTeamRoleSchema = z.enum(["admin", "member"]);
export const updateSelfhostTeamRoleSchema = z.object({
  memberId: z.string().min(1),
  role: selfhostTeamRoleSchema,
});
