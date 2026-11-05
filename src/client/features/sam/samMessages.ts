import { getToolName, isToolUIPart, type UIMessage } from "ai";
import type { ThreadMessageLike } from "@assistant-ui/react";

function failedResult(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if ("error" in value && value.error != null) return true;
  if (!("data" in value) || !value.data || typeof value.data !== "object")
    return false;
  return (
    ("status" in value.data && value.data.status === "error") ||
    ("ok" in value.data && value.data.ok === false)
  );
}

// Translate Think's AI SDK messages without owning or copying their persistence.
// Only the active assistant message may carry live progress; stored transcripts
// can retain input-streaming/reasoning states after an interrupted turn.
export function toSamThreadMessage(
  message: UIMessage,
  running = false,
): ThreadMessageLike {
  const content: Exclude<ThreadMessageLike["content"], string>[number][] = [];
  for (const part of message.parts) {
    if (part.type === "text" || part.type === "reasoning") {
      content.push({
        type: part.type,
        text: part.text,
        status:
          running && part.state === "streaming"
            ? { type: "running" }
            : { type: "complete" },
      });
    } else if (isToolUIPart(part)) {
      const done = part.state === "output-available";
      const interrupted = !running && !done;
      const result: unknown = done
        ? part.output
        : part.state === "output-error"
          ? part.errorText
          : interrupted
            ? "This tool call was interrupted."
            : undefined;
      content.push({
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: getToolName(part),
        argsText: JSON.stringify(part.input ?? {}),
        result,
        isError:
          part.state === "output-error" || interrupted || failedResult(result),
      });
    }
  }
  return {
    id: message.id,
    role: message.role,
    content,
    ...(message.role === "assistant"
      ? {
          status: running
            ? { type: "running" }
            : { type: "complete", reason: "stop" },
        }
      : {}),
  };
}
