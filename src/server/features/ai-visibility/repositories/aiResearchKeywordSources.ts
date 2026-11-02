import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  savedKeywords,
  rankTrackingConfigs,
  rankTrackingKeywords,
} from "@/db/schema";

/** Bounded, project-scoped suggestions; these reads never fetch vendor metrics. */
export async function listAiResearchKeywordSources(projectId: string) {
  const [saved, tracked] = await Promise.all([
    db
      .selectDistinct({ keyword: savedKeywords.keyword })
      .from(savedKeywords)
      .where(eq(savedKeywords.projectId, projectId))
      .orderBy(asc(savedKeywords.keyword))
      .limit(100),
    db
      .selectDistinct({ keyword: rankTrackingKeywords.keyword })
      .from(rankTrackingKeywords)
      .innerJoin(
        rankTrackingConfigs,
        eq(rankTrackingConfigs.id, rankTrackingKeywords.configId),
      )
      .where(eq(rankTrackingConfigs.projectId, projectId))
      .orderBy(asc(rankTrackingKeywords.keyword))
      .limit(100),
  ]);
  return {
    saved: saved.map((row) => row.keyword),
    tracked: tracked.map((row) => row.keyword),
  };
}
