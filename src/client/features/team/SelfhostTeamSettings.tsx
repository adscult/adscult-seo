import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ConfirmDialog } from "@/client/components/ConfirmDialog";
import { SectionHeader } from "@/client/components/PageHeader";
import { QueryState } from "@/client/components/QueryState";
import { Badge } from "@/client/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/client/components/ui/select";
import {
  Table,
  TableBody,
  TableCard,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/client/components/ui/table";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { organizationContextQueryOptions } from "./organizationQueries";
import {
  getSelfhostTeam,
  updateSelfhostTeamRole,
} from "@/serverFunctions/selfhostTeam";

const teamKey = ["selfhost-team"];
const labels = { owner: "Owner", admin: "Admin", member: "Member" };
type RoleChange = { memberId: string; email: string; role: "admin" | "member" };

export function SelfhostTeamSettings() {
  const client = useQueryClient();
  const [change, setChange] = useState<RoleChange | null>(null);
  const query = useQuery({
    queryKey: teamKey,
    queryFn: () => getSelfhostTeam(),
  });
  const mutation = useMutation({
    mutationFn: (data: RoleChange) => updateSelfhostTeamRole({ data }),
    onSuccess: async () => {
      setChange(null);
      toast.success("Team role updated");
      await Promise.all([
        client.invalidateQueries({ queryKey: teamKey }),
        client.invalidateQueries({
          queryKey: organizationContextQueryOptions().queryKey,
        }),
      ]);
    },
    onError: (error) =>
      toast.error(
        getStandardErrorMessage(error, "Could not update this role."),
      ),
  });

  return (
    <section className="space-y-3">
      <SectionHeader title="Team access" />
      <p className="text-sm text-muted-foreground">
        Members can run research, tracking, and paid API checks. Admins also
        manage projects, providers, integrations, and team roles.
      </p>
      <QueryState query={query} errorFallback="Could not load your team.">
        {(data) => (
          <TableCard>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Role</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.members.map((person) => (
                  <TableRow key={person.id}>
                    <TableCell>
                      <p className="font-medium" data-ph-mask>
                        {person.name || person.email}
                        {person.userId === data.userId ? " (you)" : ""}
                      </p>
                      <p className="text-xs text-muted-foreground" data-ph-mask>
                        {person.email}
                      </p>
                    </TableCell>
                    <TableCell>
                      {data.canManage &&
                      person.role !== "owner" &&
                      person.userId !== data.userId ? (
                        <Select
                          value={person.role}
                          disabled={mutation.isPending}
                          onValueChange={(role) => {
                            if (
                              (role === "admin" || role === "member") &&
                              role !== person.role
                            )
                              setChange({
                                memberId: person.id,
                                email: person.email,
                                role,
                              });
                          }}
                        >
                          <SelectTrigger
                            size="sm"
                            aria-label={`Role for ${person.email}`}
                          >
                            <SelectValue>{labels[person.role]}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="member">Member</SelectItem>
                            <SelectItem value="admin">Admin</SelectItem>
                          </SelectContent>
                        </Select>
                      ) : (
                        <Badge variant="secondary">{labels[person.role]}</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableCard>
        )}
      </QueryState>
      <p className="text-sm text-muted-foreground">
        Add or revoke sign-in access in Cloudflare Access. People appear here
        after their first sign-in and start as Members. Owner accounts are
        configured by the deployment operator.
      </p>
      {change ? (
        <ConfirmDialog
          title={`Change ${change.email} to ${labels[change.role]}?`}
          confirmLabel="Change role"
          pending={mutation.isPending}
          onClose={() => setChange(null)}
          onConfirm={() => mutation.mutate(change)}
        >
          {change.role === "admin"
            ? "Admins can change provider credentials, create and archive projects, manage integrations, and change other team roles."
            : "Members can still run paid API checks. They cannot manage providers, integrations, or team roles."}
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
