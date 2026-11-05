export function samConfig(read: (name: string) => string | undefined) {
  const provider = read("SAM_PROVIDER") ?? "openrouter";
  if (provider !== "openrouter" && provider !== "anthropic") {
    throw new Error("SAM_PROVIDER must be openrouter or anthropic");
  }
  const profile = read("SAM_TOOL_PROFILE") ?? "full";
  if (profile !== "full" && profile !== "connected_data") {
    throw new Error("SAM_TOOL_PROFILE must be full or connected_data");
  }
  const model =
    provider === "anthropic"
      ? (read("ANTHROPIC_MODEL") ?? "latest-sonnet")
      : (read("OPENROUTER_MODEL") ?? "openai/gpt-5.6-luna");
  const allowedModels = read("SAM_MODELS")
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    provider,
    profile,
    model,
    models: [
      ...new Set([
        ...(model === "latest-sonnet" ? [] : [model]),
        ...(allowedModels ?? []),
      ]),
    ],
    restrictModels: Boolean(allowedModels?.length),
    keyName:
      provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENROUTER_API_KEY",
  } as const;
}

export const SAM_DAILY_TOKEN_ALLOWANCE = 1_000_000;

export function samUsageDay(now = new Date()) {
  // Kolkata has a fixed UTC+05:30 offset, with no daylight saving time.
  const offset = 330 * 60_000;
  const date = new Date(now.getTime() + offset).toISOString().slice(0, 10);
  const resetAt = new Date(
    Date.parse(`${date}T00:00:00Z`) + 86_400_000 - offset,
  ).toISOString();
  return { date, resetAt };
}
