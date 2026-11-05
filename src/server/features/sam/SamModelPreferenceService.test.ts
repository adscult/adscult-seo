import { expect, it } from "vitest";
import { SamModelPreferenceService } from "./SamModelPreferenceService";

const config = {
  model: "claude-sonnet-4-6",
  models: ["claude-sonnet-4-6", "claude-opus-4-6"],
};
function storage() {
  const records = new Map<string, unknown>();
  return {
    get: async (key: string) => records.get(key),
    put: async (key: string, value: string) => {
      records.set(key, value);
    },
  };
}

it("saves a conversation's selection and keeps other conversations on their defaults", async () => {
  const firstChat = storage();
  const secondChat = storage();
  await SamModelPreferenceService.set(firstChat, config, {
    model: "claude-opus-4-6",
  });
  expect(await SamModelPreferenceService.get(firstChat, config)).toBe(
    "claude-opus-4-6",
  );
  expect(await SamModelPreferenceService.get(secondChat, config)).toBe(
    "claude-sonnet-4-6",
  );
});

it("rejects an unapproved model without replacing the saved selection", async () => {
  const chat = storage();
  await SamModelPreferenceService.set(chat, config, {
    model: "claude-opus-4-6",
  });
  await expect(
    SamModelPreferenceService.set(chat, config, { model: "arbitrary-model" }),
  ).rejects.toThrow("available SAM models");
  expect(await SamModelPreferenceService.get(chat, config)).toBe(
    "claude-opus-4-6",
  );
});

it("uses the deployment default if an administrator removes the saved model", async () => {
  const chat = storage();
  await SamModelPreferenceService.set(chat, config, {
    model: "claude-opus-4-6",
  });
  expect(
    await SamModelPreferenceService.get(chat, {
      ...config,
      models: [config.model],
    }),
  ).toBe(config.model);
});
