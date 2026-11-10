import { Link } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { GateCard } from "@/client/components/GateCard";
import { Button } from "@/client/components/ui/button";

/**
 * Shown on the chat route until the user opts into Sam.
 */
export function SamBetaGate({ onContinue }: { onContinue: () => void }) {
  return (
    <GateCard
      icon={Sparkles}
      title="Sam is in beta"
      description={
        <>
          <p>
            Ask Sam about your projects, search data, and saved keywords. For
            For deeper workflows, connect your AI tool over MCP.
          </p>
          <p>You can still use Sam, but it is early and has rough edges.</p>
        </>
      }
      actions={
        <>
          <Button size="lg" nativeButton={false} render={<Link to="/ai" />}>
            Set up your agent
          </Button>
          <Button size="lg" variant="ghost" onClick={onContinue}>
            Use Sam anyway
          </Button>
        </>
      }
    />
  );
}
