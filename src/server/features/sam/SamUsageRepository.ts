import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { samModelCalls, samUsageDays } from "@/db/schema";
import { SAM_DAILY_TOKEN_ALLOWANCE, samUsageDay } from "@/shared/sam-config";

export const SamUsageRepository = {
  async status(organizationId: string, now = new Date()) {
    const { date, resetAt } = samUsageDay(now);
    const usageDayId = `${organizationId}:${date}`;
    const [row] = await db
      .select({
        tokens: sql<number>`coalesce(sum(${samModelCalls.inputTokens} + ${samModelCalls.outputTokens}), 0)`,
      })
      .from(samModelCalls)
      .where(eq(samModelCalls.usageDayId, usageDayId));
    return {
      usageDayId,
      date,
      resetAt,
      tokens: Number(row?.tokens ?? 0),
      allowance: SAM_DAILY_TOKEN_ALLOWANCE,
    };
  },

  async admit(input: {
    organizationId: string;
    sessionId: string;
    provider: string;
    model: string;
    purpose: string;
  }) {
    const status = await this.status(input.organizationId);
    if (status.tokens >= status.allowance) {
      throw new Error(
        `The team's daily token allowance is exhausted. It resets at ${status.resetAt} (midnight Asia/Kolkata).`,
      );
    }
    await db
      .insert(samUsageDays)
      .values({
        id: status.usageDayId,
        organizationId: input.organizationId,
        date: status.date,
      })
      .onConflictDoNothing();
    const id = crypto.randomUUID();
    await db.insert(samModelCalls).values({
      id,
      usageDayId: status.usageDayId,
      sessionId: input.sessionId,
      provider: input.provider,
      model: input.model,
      purpose: input.purpose,
      status: "admitted",
      startedAt: new Date().toISOString(),
    });
    return id;
  },

  async finish(
    id: string,
    usage?: {
      inputTokens: { total?: number };
      outputTokens: { total?: number };
    },
  ) {
    // One terminal write per call. Retrying a returned usage event cannot charge it twice.
    await db
      .update(samModelCalls)
      .set({
        status: usage ? "completed" : "interrupted",
        inputTokens: usage?.inputTokens.total ?? 0,
        outputTokens: usage?.outputTokens.total ?? 0,
        finishedAt: new Date().toISOString(),
      })
      .where(and(eq(samModelCalls.id, id), isNull(samModelCalls.finishedAt)));
  },
};
