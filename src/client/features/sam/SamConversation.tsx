import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/think/react";
import {
  AssistantRuntimeProvider,
  MessageNotSentError,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import { findLast } from "remeda";
import { toast } from "sonner";
import { invalidateSamSessions } from "./samQueries";
import { captureClientEvent } from "@/client/lib/posthog";
import { ErrorState } from "@/client/components/ErrorState";
import { Button } from "@/client/components/ui/button";
import { useSamModelPreference } from "./SamModelSelector";
import { SamThread } from "./SamThread";
import { toSamThreadMessage } from "./samMessages";

function textOf(parts: readonly { type: string; text?: string }[]) {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

export function SamConversation({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}) {
  const agent = useAgent({ agent: "sam-chat", name: sessionId });
  const modelPreference = useSamModelPreference(sessionId);
  const modelPending =
    !modelPreference.query.data || modelPreference.mutation.isPending;
  // Think still owns the WebSocket, transcript, and streaming. Throttle dense
  // tool-input deltas before passing that state to assistant-ui.
  const {
    messages,
    sendMessage,
    setMessages,
    status,
    stop,
    isRecovering,
    connectionError,
    error,
  } = useAgentChat({ agent, experimental_throttle: 50 });
  const isBusy =
    status === "submitted" || status === "streaming" || isRecovering;

  const sendText = async (
    text: string,
    source: "composer" | "edit" | "retry" = "composer",
  ) => {
    if (modelPending || isBusy || connectionError || !agent.identified) {
      throw new MessageNotSentError(
        "SAM isn't ready to send yet. Your draft has been kept.",
      );
    }
    captureClientEvent("sam:message_send", {
      session_id: sessionId,
      project_id: projectId,
      source,
      chars: text.length,
    });
    await sendMessage({ text });
  };

  useEffect(() => {
    if (status !== "error" && !connectionError) return;
    captureClientEvent("sam:client_error", {
      session_id: sessionId,
      project_id: projectId,
      kind: connectionError ? "connection" : "turn",
      code: connectionError?.code,
      reason: connectionError?.reason,
    });
  }, [status, connectionError, sessionId, projectId]);

  const [hasConnected, setHasConnected] = useState(false);
  useEffect(() => {
    if (agent.identified) setHasConnected(true);
  }, [agent.identified]);
  const isReconnecting = hasConnected && !agent.identified && !connectionError;

  // Rewind is authoritative on the server and aborts an in-flight turn. Refresh
  // Think's local message state before an edited question or retry is sent.
  const rewindTo = async (messageId: string) => {
    const response = await fetch(`/agents/sam-chat/${sessionId}/rewind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId }),
    }).catch(() => null);
    if (!response?.ok) {
      toast.error("Couldn't change the conversation. Try again.");
      return false;
    }
    const fresh = await fetch(`/agents/sam-chat/${sessionId}/get-messages`)
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null);
    if (!Array.isArray(fresh)) {
      toast.error(
        "Couldn't reload the conversation. Refresh before trying again.",
      );
      return false;
    }
    setMessages(fresh);
    return true;
  };

  const editAndResend = async (
    messageId: string,
    text: string,
    source: "edit" | "retry" = "edit",
  ) => {
    if (modelPending)
      throw new MessageNotSentError(
        "Wait for the model selection to finish saving.",
      );
    if (await rewindTo(messageId)) await sendText(text, source);
  };
  const regenerate = async (parentId: string | null) => {
    const index = messages.findIndex((message) => message.id === parentId);
    const question = findLast(
      messages.slice(0, index + 1),
      (message) => message.role === "user",
    );
    if (!question)
      throw new MessageNotSentError(
        "Could not find the question to regenerate. Refresh the conversation and try again.",
      );
    await editAndResend(question.id, textOf(question.parts), "retry");
  };
  const lastUserMessage = findLast(
    messages,
    (message) => message.role === "user",
  );
  const retryLast = () => {
    if (!lastUserMessage) return;
    void editAndResend(
      lastUserMessage.id,
      textOf(lastUserMessage.parts),
      "retry",
    ).catch((failure: unknown) =>
      toast.error(
        failure instanceof Error
          ? failure.message
          : "Could not retry the message.",
      ),
    );
  };

  const wasBusy = useRef(false);
  useEffect(() => {
    if (isBusy) {
      wasBusy.current = true;
      return;
    }
    if (wasBusy.current) {
      wasBusy.current = false;
      void invalidateSamSessions(projectId);
    }
  }, [isBusy, projectId]);

  const convertMessage = useCallback(
    (message: UIMessage, index: number) =>
      toSamThreadMessage(message, isBusy && index === messages.length - 1),
    [isBusy, messages.length],
  );
  const runtime = useExternalStoreRuntime<UIMessage>({
    messages,
    convertMessage,
    isRunning: isBusy,
    isDisabled:
      modelPending ||
      isRecovering ||
      Boolean(connectionError) ||
      !agent.identified,
    onNew: async (message) => {
      await sendText(textOf(message.content));
    },
    onEdit: async (message) => {
      if (!message.sourceId)
        throw new MessageNotSentError("Could not find the message to edit.");
      await editAndResend(message.sourceId, textOf(message.content));
    },
    onReload: regenerate,
    onCancel: async () => {
      await stop();
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <SamThread
        modelPreference={modelPreference}
        busy={isBusy}
        onUndo={(id) => void rewindTo(id)}
        notice={
          <>
            {isRecovering && (
              <p className="mb-3 text-xs text-muted-foreground" role="status">
                Saving the reply that got cut off…
              </p>
            )}
            {status === "error" && (
              <div className="mb-3">
                <ErrorState
                  variant="inline"
                  message={
                    error?.message ||
                    "SAM stopped before finishing. The partial reply is saved."
                  }
                  onRetry={lastUserMessage ? retryLast : undefined}
                  isRetrying={isBusy || modelPending}
                />
              </div>
            )}
            {connectionError ? (
              <div className="mb-3">
                <ErrorState
                  variant="inline"
                  message="Lost the connection to SAM."
                  action={
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => agent.reconnect()}
                    >
                      Reconnect
                    </Button>
                  }
                />
              </div>
            ) : isReconnecting ? (
              <p className="mb-3 text-xs text-muted-foreground" role="status">
                Reconnecting…
              </p>
            ) : null}
          </>
        }
      />
    </AssistantRuntimeProvider>
  );
}
