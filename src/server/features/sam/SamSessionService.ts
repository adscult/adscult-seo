import { env } from "cloudflare:workers";
import type { SamChatAgent } from "./SamChatAgent";
import { SamSessionRepository } from "./SamSessionRepository";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { AppError } from "@/server/lib/errors";

export const SamSessionService = {
  async deleteSession(input: {
    sessionId: string;
    userId: string;
    organizationId: string;
  }) {
    const session = await SamSessionRepository.getActiveSession(
      input.sessionId,
      input.userId,
    );
    const project = session
      ? await ProjectRepository.getProjectForOrganization(
          session.projectId,
          input.organizationId,
        )
      : null;
    if (!session || !project)
      throw new AppError("NOT_FOUND", "Chat session not found");

    // Refuse new connections while the transcript is erased. Restore visibility
    // on failure so the user can retry instead of losing the deletion control.
    await SamSessionRepository.setArchived(session.id, true);
    try {
      const chats =
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the binding is declared as this class in wrangler.jsonc
        env.SAM_CHAT as unknown as DurableObjectNamespace<SamChatAgent>;
      await chats.get(chats.idFromName(session.id)).destroyForErasure();
      // Usage records keep their totals and set session_id to null via the FK.
      await SamSessionRepository.deleteSession(session.id);
    } catch (error) {
      await SamSessionRepository.setArchived(session.id, false);
      throw error;
    }
    return { projectId: project.id, sessionId: session.id };
  },
};
