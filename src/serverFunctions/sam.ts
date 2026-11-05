import { createServerFn } from "@tanstack/react-start";
import { waitUntil } from "cloudflare:workers";
import { z } from "zod";
import {
  requireAuthenticatedContext,
  requireProjectContext,
} from "@/serverFunctions/middleware";
import { AppError } from "@/server/lib/errors";
import { captureServerEvent } from "@/server/lib/posthog";
import { SamSessionRepository } from "@/server/features/sam/SamSessionRepository";
import { SamSessionService } from "@/server/features/sam/SamSessionService";

// The ensure-user middleware authorizes `projectId` against the caller's org
// (ADR 0001); requireProjectContext exposes the verified project.
const projectScopedSchema = z.object({ projectId: z.string().min(1) });

// Lists the SAM chat sessions for a project (newest first) for the side-panel.
export const listSamSessions = createServerFn({ method: "GET" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    return SamSessionRepository.listSessionsForProject(
      context.projectId,
      context.userId,
    );
  });

// Creates a new SAM chat session and returns its id; the client then opens a DO
// connection keyed by that id.
export const createSamSession = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    const session = await SamSessionRepository.createSession({
      projectId: context.projectId,
      userId: context.userId,
    });
    if (!session) {
      throw new AppError("INTERNAL_ERROR", "Failed to create chat session");
    }
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "sam:session_create",
        organizationId: context.organizationId,
        properties: { project_id: context.projectId, session_id: session.id },
      }),
    );
    return { id: session.id };
  });

export const deleteSamSession = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(z.object({ sessionId: z.string().min(1) }))
  .handler(async ({ data, context }) => {
    const deleted = await SamSessionService.deleteSession({
      sessionId: data.sessionId,
      userId: context.userId,
      organizationId: context.organizationId,
    });
    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "sam:session_delete",
        organizationId: context.organizationId,
        properties: {
          project_id: deleted.projectId,
          session_id: deleted.sessionId,
        },
      }),
    );
    return { ok: true };
  });
