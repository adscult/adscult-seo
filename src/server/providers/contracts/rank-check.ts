import { z } from "zod";
import type { SerpRequest } from "./serp";

export const rankCheckResultSchema = z.object({
  keywordId: z.string(),
  keyword: z.string(),
  // Existing tracker semantics: organic rank, with absolute rank as a fallback
  // only when the vendor omitted the organic rank. Null means not found.
  position: z.number().int().positive().nullable(),
  url: z.string().nullable(),
  serpFeatures: z.array(z.string()),
});
export type RankCheckResult = z.infer<typeof rankCheckResultSchema>;
export interface RankCheckRequest extends Omit<SerpRequest, "device"> {
  keywordId: string;
  targetDomain: string;
  device: "desktop" | "mobile" | "provider";
  depth: number;
}
export interface RankCheckTaskInput {
  keyword: string;
  keywordId: string;
  device: "desktop" | "mobile" | "provider";
}
export interface PostedRankCheckTask extends RankCheckTaskInput {
  taskId: string;
}
export interface RankTaskRequest {
  tasks: RankCheckTaskInput[];
  locationCode: number;
  languageCode: string;
  locationName?: string;
  depth: number;
  targetDomain: string;
}
