import { ShieldAlert, Wrench } from "lucide-react";
import { GateCard } from "@/client/components/GateCard";
import { Alert, AlertDescription } from "@/client/components/ui/alert";
import { Button } from "@/client/components/ui/button";

export function SamSetupGate({
  errorMessage,
  isRefetching,
  onRetry,
  provider,
}: {
  errorMessage: string | null;
  isRefetching: boolean;
  onRetry: () => void;
  provider: "openrouter" | "anthropic";
}) {
  const name = provider === "anthropic" ? "Anthropic" : "OpenRouter";
  const keyName =
    provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENROUTER_API_KEY";
  const keyUrl =
    provider === "anthropic"
      ? "https://console.anthropic.com/settings/keys"
      : "https://openrouter.ai/settings/keys";
  return (
    <GateCard
      icon={Wrench}
      tone="warning"
      title="Enable AI Features"
      description={
        <>
          <p>
            SAM needs a {name} API key. Create a key on {name}, set it as the{" "}
            <code>{keyName}</code> environment variable, restart OpenSEO, then
            confirm here.
          </p>
          <p className="text-xs">
            The selected provider is {name}. Set SAM_PROVIDER to change it.
          </p>
        </>
      }
      actions={
        <>
          <Button size="lg" pending={isRefetching} onClick={onRetry}>
            Confirm API Key
          </Button>
          <Button
            size="lg"
            variant="outline"
            nativeButton={false}
            render={<a href={keyUrl} target="_blank" rel="noreferrer" />}
          >
            Open {name} Keys
          </Button>
        </>
      }
    >
      {errorMessage ? (
        <Alert variant="warning">
          <ShieldAlert />
          <AlertDescription className="text-foreground">
            {errorMessage}
          </AlertDescription>
        </Alert>
      ) : null}
    </GateCard>
  );
}
