import type { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";

export type EnsuredProject = NonNullable<
  Awaited<ReturnType<typeof ProjectRepository.getProjectForOrganization>>
>;

export type EnsuredUserContext = {
  userId: string;
  userEmail: string;
  // True when the user's email is verified (hosted) or auth is delegated
  // (Cloudflare Access / local), where there is no unverified state. Used to
  // gate paid onboarding spend behind verification.
  emailVerified: boolean;
  organizationId: string;
  // The caller's role in organizationId, from their member row (comma-joined
  // when multiple; check via hasOrgPermission, never string equality).
  // Cloudflare Access uses stored team roles with operator-configured owners.
  // Local no-auth has one implicit owner.
  role: string;
  project?: EnsuredProject;
};
