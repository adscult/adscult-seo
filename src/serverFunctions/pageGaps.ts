import { createServerFn } from "@tanstack/react-start";
import { requireProjectContext } from "@/serverFunctions/middleware";
import { pageGapInputSchema } from "@/types/schemas/page-gaps";
import { PageGapService } from "@/server/features/page-gaps/services/PageGapService";

export const compareSitemaps = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(pageGapInputSchema)
  .handler(({ data }) => PageGapService.compareSitemaps(data));
