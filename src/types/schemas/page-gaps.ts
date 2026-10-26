import { z } from "zod";

export const pageGapInputSchema = z.object({
  projectId: z.string().min(1),
  website: z.string().trim().min(1).max(2048),
  competitors: z.array(z.string().trim().min(1).max(2048)).min(1).max(3),
});

export type SitemapSite = {
  origin: string;
  pageCount: number;
  status: "available" | "partial" | "unavailable";
};

export type PageGap = {
  topic: string;
  kind: "Category" | "Product" | "Content" | "Service" | "Other";
  suggestedPath: string;
  competitors: { origin: string; url: string }[];
  similarPage: string | null;
};

export type PageGapComparison = {
  checkedAt: string;
  website: SitemapSite;
  competitors: SitemapSite[];
  gaps: PageGap[];
  coveredTopics: number;
  totalGaps: number;
};
