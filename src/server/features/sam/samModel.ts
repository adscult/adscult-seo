import { APICallError, wrapLanguageModel } from "ai";
import type { LanguageModelV3 } from "@openrouter/ai-sdk-provider";
import { withPgClient } from "@/db";
import { samConfig } from "@/shared/sam-config";
import { getEnvValueSync } from "@/server/lib/runtime-env";
import { buildChatAgentModel } from "@/server/lib/openrouter";
import { SamUsageRepository } from "./SamUsageRepository";

function providerError(error: unknown): unknown {
  if (!APICallError.isInstance(error)) return error;
  if (error.statusCode === 401 || error.statusCode === 403) {
    return new Error(
      "SAM's provider credentials were rejected. Ask an administrator to check the selected provider's API key.",
    );
  }
  if (error.statusCode === 429 || error.statusCode === 402) {
    return new Error(
      "SAM's provider has reached a rate or credit limit. Try later, or ask an administrator to check the provider account.",
    );
  }
  return new Error(
    "SAM's provider could not finish this response. The partial reply is saved; try again with a smaller request.",
  );
}

type ModelStreamPart =
  Awaited<
    ReturnType<LanguageModelV3["doStream"]>
  >["stream"] extends ReadableStream<infer T>
    ? T
    : never;

// Think resolves models synchronously. Load the adapter at the first call,
// keeping its schemas outside the Worker's eager startup graph.
function anthropicModel(apiKey: string, modelId: string): LanguageModelV3 {
  const load = async () => {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    return createAnthropic({ apiKey })(modelId);
  };
  return {
    specificationVersion: "v3",
    provider: "anthropic.messages",
    modelId,
    supportedUrls: {},
    doGenerate: async (options) => (await load()).doGenerate(options),
    doStream: async (options) => (await load()).doStream(options),
  };
}

export function buildSamModel(
  env: object,
  reasoningEffort: "max" | "low",
  admit: (provider: string, model: string) => Promise<string>,
  selectedModel?: string,
): LanguageModelV3 {
  const config = samConfig((name) => getEnvValueSync(env, name));
  const modelId = selectedModel ?? config.model;
  if (config.restrictModels && !config.models.includes(modelId)) {
    throw new Error("Choose one of the available SAM models.");
  }
  const key = getEnvValueSync(env, config.keyName);
  if (!key)
    throw new Error(
      `${config.keyName} is required for SAM. Ask an administrator to configure it and restart OpenSEO.`,
    );
  const model =
    config.provider === "anthropic"
      ? anthropicModel(key, modelId)
      : buildChatAgentModel(key, modelId, reasoningEffort);
  const finish = (
    id: string,
    usage?: Parameters<typeof SamUsageRepository.finish>[1],
  ) => withPgClient(() => SamUsageRepository.finish(id, usage));
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      wrapGenerate: async ({ doGenerate }) => {
        const id = await admit(config.provider, modelId);
        let returned = false;
        try {
          const result = await doGenerate();
          returned = true;
          await finish(id, result.usage);
          return result;
        } catch (error) {
          if (!returned) await finish(id);
          throw providerError(error);
        }
      },
      wrapStream: async ({ doStream }) => {
        const id = await admit(config.provider, modelId);
        try {
          const result = await doStream();
          const reader = result.stream.getReader();
          let finished = false;
          // Persist the provider's finish event before the SDK can start another step.
          const stream = new ReadableStream<ModelStreamPart>({
            async pull(controller) {
              try {
                const next = await reader.read();
                if (next.done) {
                  if (!finished) await finish(id);
                  controller.close();
                  return;
                }
                if (next.value.type === "finish") {
                  finished = true;
                  await finish(id, next.value.usage);
                }
                controller.enqueue(next.value);
              } catch (error) {
                if (!finished) await finish(id);
                controller.error(providerError(error));
              }
            },
            async cancel(reason) {
              if (!finished) await finish(id);
              // Provider transforms can leave cancellation pending until their
              // upstream fetch settles. Persist first and release the caller.
              void reader.cancel(reason).catch(() => {});
            },
          });
          return { ...result, stream };
        } catch (error) {
          await finish(id);
          throw providerError(error);
        }
      },
    },
  });
}
