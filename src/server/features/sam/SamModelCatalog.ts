import { z } from "zod";
import { sortBy } from "remeda";
import type { samConfig } from "@/shared/sam-config";

type Config = ReturnType<typeof samConfig>;
const anthropicPage = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      display_name: z.string(),
      lifecycle: z.string().optional(),
    }),
  ),
  has_more: z.boolean(),
  last_id: z.string().nullable(),
});
const openrouterPage = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      supported_parameters: z.array(z.string()),
      architecture: z.object({ output_modalities: z.array(z.string()) }),
    }),
  ),
});
type Catalog = { models: string[]; labels: Record<string, string> };

function claudeVersion(label: string) {
  const match = /\bClaude\s+(?:[a-z]+\s+)?(\d+)(?:\.(\d+))?\b/i.exec(label);
  return match
    ? ([Number(match[1]), Number(match[2] ?? 0)] as const)
    : undefined;
}

// Scoped to the conversation's agent; credentials never leave the server.
export class SamModelCatalog {
  private cached?: {
    key: string;
    provider: string;
    expires: number;
    catalog: Catalog;
  };

  async get(config: Config, key: string | undefined) {
    if (!key)
      throw new Error(`${config.keyName} is required to load SAM models.`);
    let catalog =
      this.cached?.key === key &&
      this.cached.provider === config.provider &&
      this.cached.expires > Date.now()
        ? this.cached.catalog
        : undefined;
    if (!catalog) {
      const labels: Record<string, string> = {};
      let cursor: string | null = null;
      do {
        const url = new URL(
          config.provider === "anthropic"
            ? "https://api.anthropic.com/v1/models"
            : "https://openrouter.ai/api/v1/models",
        );
        if (config.provider === "anthropic") {
          url.searchParams.set("limit", "1000");
          if (cursor) url.searchParams.set("after_id", cursor);
        }
        const response = await fetch(url, {
          headers:
            config.provider === "anthropic"
              ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
              : { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          throw new Error(
            response.status === 401 || response.status === 403
              ? "SAM's provider credentials were rejected. Ask an administrator to check the API key."
              : "Could not load models from SAM's provider. Try again shortly.",
          );
        }
        const body: unknown = await response.json();
        if (config.provider === "anthropic") {
          const page = anthropicPage.parse(body);
          for (const model of page.data.filter(
            (entry) => !entry.lifecycle || entry.lifecycle === "active",
          )) {
            labels[model.id] = model.display_name;
          }
          if (page.has_more && (!page.last_id || page.last_id === cursor)) {
            throw new Error(
              "SAM's provider returned an incomplete model list. Try again.",
            );
          }
          cursor = page.has_more ? page.last_id : null;
        } else {
          const models = openrouterPage
            .parse(body)
            .data.filter(
              (model) =>
                model.architecture.output_modalities.includes("text") &&
                model.supported_parameters.includes("tools"),
            );
          for (const model of models) {
            labels[model.id] = model.name;
          }
        }
      } while (cursor);
      catalog = { models: Object.keys(labels), labels };
      this.cached = {
        key,
        provider: config.provider,
        expires: Date.now() + 300_000,
        catalog,
      };
    }
    const available = config.restrictModels
      ? catalog.models.filter((model) => config.models.includes(model))
      : catalog.models;
    const sonnets = sortBy(
      available.filter((id) => /\bsonnet\b/i.test(catalog.labels[id])),
      (id) => -(claudeVersion(catalog.labels[id])?.[0] ?? 0),
      (id) => -(claudeVersion(catalog.labels[id])?.[1] ?? 0),
    );
    const model =
      config.provider === "anthropic" && config.model === "latest-sonnet"
        ? sonnets[0]
        : config.model;
    if (!model)
      throw new Error(
        "No Sonnet model is available. Ask an administrator to check SAM's model allowlist.",
      );
    const models = [...new Set([model, ...available])];
    const labels = Object.fromEntries(
      models.map((id) => [id, catalog.labels[id] ?? id]),
    );
    const newestGeneration = Math.max(
      0,
      ...catalog.models.map(
        (id) => claudeVersion(catalog.labels[id])?.[0] ?? 0,
      ),
    );
    const groups = [
      {
        label: "New generation",
        models: models.filter(
          (id) => claudeVersion(labels[id])?.[0] === newestGeneration,
        ),
      },
      {
        label: "Older generation",
        models: models.filter((id) => {
          const version = claudeVersion(labels[id]);
          return version && version[0] < newestGeneration;
        }),
      },
      {
        label: "Other models",
        models: models.filter((id) => !claudeVersion(labels[id])),
      },
    ].filter((group) => group.models.length > 0);
    return {
      model,
      models,
      labels,
      groups,
    };
  }
}
