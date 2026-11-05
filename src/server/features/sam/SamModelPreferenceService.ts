import { z } from "zod";
import type { samConfig } from "@/shared/sam-config";
import { AppError } from "@/server/lib/errors";

const MODEL_KEY = "sam-model";
const selectionSchema = z.object({ model: z.string().min(1).max(200) });
type Config = Pick<ReturnType<typeof samConfig>, "model" | "models">;
type Storage = {
  get(key: string): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
};

// The preference belongs to the conversation, alongside its DO transcript.
// It stores only a model id; the provider and credentials remain deployment settings.
export const SamModelPreferenceService = {
  async get(storage: Storage, config: Config): Promise<string> {
    const selected = await storage.get(MODEL_KEY);
    return typeof selected === "string" && config.models.includes(selected)
      ? selected
      : config.model;
  },
  async set(storage: Storage, config: Config, input: unknown): Promise<string> {
    const parsed = selectionSchema.safeParse(input);
    if (!parsed.success || !config.models.includes(parsed.data.model)) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Choose one of the available SAM models.",
      );
    }
    const { model } = parsed.data;
    await storage.put(MODEL_KEY, model);
    return model;
  },
};
