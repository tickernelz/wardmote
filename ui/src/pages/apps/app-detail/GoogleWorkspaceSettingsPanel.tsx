import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GOOGLE_WORKSPACE_POLICY_ACTIONS,
  GOOGLE_WORKSPACE_POLICY_CLASSES,
  type GoogleWorkspacePolicyAction,
  type GoogleWorkspacePolicyClass,
  type GoogleWorkspaceService,
  type GoogleWorkspaceSettings,
  type GoogleWorkspaceTier,
  type ToolConnection,
} from "@tickernelz/wardmote-shared";
import { toolsApi } from "@/api/tools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { GoogleWorkspaceCapabilities } from "@/features/connections/google-workspace/GoogleWorkspaceCapabilities";

const CLASS_LABELS: Record<GoogleWorkspacePolicyClass, string> = {
  write: "Edit and create",
  destructive: "Delete",
  external: "Share outside the domain or send email",
  execute: "Run Apps Script",
  unreviewed: "Methods Wardmote has not reviewed yet",
};

const ACTION_LABELS: Record<GoogleWorkspacePolicyAction, string> = {
  allow: "Runs directly",
  require_approval: "Asks for approval",
  block: "Blocked",
};

const DRIVE_ID = /(?:\/folders\/|\/d\/|[?&]id=)([A-Za-z0-9_-]+)/;

export function parseGoogleIdList(text: string): string[] {
  const ids = text
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => DRIVE_ID.exec(item)?.[1] ?? item)
    .filter((item) => /^[A-Za-z0-9_-]{1,200}$/.test(item));
  return [...new Set(ids)];
}

type Draft = {
  capabilities: Partial<Record<GoogleWorkspaceService, GoogleWorkspaceTier>>;
  classPolicy: Record<GoogleWorkspacePolicyClass, GoogleWorkspacePolicyAction>;
  folders: string;
  sharedDrives: string;
  spreadsheets: string;
  domain: string;
};

function draftFrom(settings: GoogleWorkspaceSettings): Draft {
  return {
    capabilities: settings.capabilities,
    classPolicy: settings.classPolicy,
    folders: settings.scope.driveFolderIds.join("\n"),
    sharedDrives: settings.scope.sharedDriveIds.join("\n"),
    spreadsheets: settings.scope.spreadsheetIds.join("\n"),
    domain: settings.domain ?? "",
  };
}

export function GoogleWorkspaceSettingsPanel({ connection, canConfigure }: { connection: ToolConnection; canConfigure: boolean }) {
  const id = useId();
  const queryClient = useQueryClient();
  const queryKey = ["tools", "google-workspace-settings", connection.id];
  const settings = useQuery({ queryKey, queryFn: () => toolsApi.googleWorkspaceSettings(connection.id), enabled: canConfigure });
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    if (settings.data) setDraft(draftFrom(settings.data.settings));
  }, [settings.data]);
  const save = useMutation({
    mutationFn: (value: Draft) =>
      toolsApi.configureGoogleWorkspace(connection.id, {
        capabilities: value.capabilities,
        classPolicy: value.classPolicy,
        methodOverrides: settings.data?.settings.methodOverrides ?? {},
        scope: { driveFolderIds: parseGoogleIdList(value.folders), sharedDriveIds: parseGoogleIdList(value.sharedDrives), spreadsheetIds: parseGoogleIdList(value.spreadsheets) },
        domain: value.domain.trim().toLowerCase() || null,
      }),
    onSuccess: (view) => queryClient.setQueryData(queryKey, view),
  });
  const grantMore = useMutation({
    mutationFn: () => toolsApi.startOAuth(connection.id, { asCurrentUser: connection.credentialPolicy === "per_user" }),
    onSuccess: (start) => window.location.assign(start.authorizationUrl),
  });
  if (!canConfigure) {
    return <p className="text-sm text-ink-3">Only someone who can configure this connection can change its Google service levels and policy.</p>;
  }
  if (settings.isLoading || !draft) return <p className="text-sm text-ink-3">Loading Google Workspace settings…</p>;
  if (settings.isError) return <p role="alert" className="text-sm text-bad">{settings.error instanceof Error ? settings.error.message : "Settings could not be loaded."}</p>;
  const missing = [...new Set((settings.data?.grants ?? []).flatMap((grant) => grant.missingScopes))];
  const dirty = settings.data ? JSON.stringify(draftFrom(settings.data.settings)) !== JSON.stringify(draft) : false;
  return (
    <section className="space-y-6" aria-labelledby={`${id}-title`}>
      <div className="space-y-1">
        <h2 id={`${id}-title`} className="text-lg font-semibold">Google Workspace access</h2>
        <p className="text-sm text-ink-3">What agents may do in each Google service, what needs a person's approval, and which Drive folders they may touch.</p>
      </div>
      {missing.length > 0 && (
        <div role="status" className="space-y-2 rounded-lg border border-warn bg-warn-soft p-3 text-sm">
          <p className="font-medium">Google has not granted {missing.length} scope{missing.length === 1 ? "" : "s"} these levels need.</p>
          <p className="break-words font-mono text-xs text-ink-2">{missing.map((scope) => scope.replace("https://www.googleapis.com/auth/", "")).join(", ")}</p>
          <Button variant="secondary" disabled={grantMore.isPending || dirty} onClick={() => grantMore.mutate()}>
            {grantMore.isPending ? "Opening Google…" : "Grant the added access in Google"}
          </Button>
          {dirty && <p className="text-ink-3">Save the levels first.</p>}
        </div>
      )}
      <GoogleWorkspaceCapabilities capabilities={draft.capabilities} onChange={(service, tier) => setDraft({ ...draft, capabilities: { ...draft.capabilities, [service]: tier } })} disabled={save.isPending} />
      <div className="space-y-3">
        <h3 className="font-medium">Approval policy</h3>
        <div className="divide-y divide-line rounded-lg border border-line">
          {GOOGLE_WORKSPACE_POLICY_CLASSES.map((name) => (
            <div key={name} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
              <Label htmlFor={`${id}-${name}`}>{CLASS_LABELS[name]}</Label>
              <select
                id={`${id}-${name}`}
                className="rounded-md border border-line-strong bg-bg px-3 py-2 text-sm"
                value={draft.classPolicy[name]}
                onChange={(event) => setDraft({ ...draft, classPolicy: { ...draft.classPolicy, [name]: event.target.value as GoogleWorkspacePolicyAction } })}
              >
                {GOOGLE_WORKSPACE_POLICY_ACTIONS.map((action) => <option key={action} value={action}>{ACTION_LABELS[action]}</option>)}
              </select>
            </div>
          ))}
        </div>
        <p className="text-sm text-ink-3">Reading always runs. Emptying the Drive trash is always blocked, even with approval.</p>
      </div>
      <div className="space-y-3">
        <h3 className="font-medium">Limit Drive, Sheets, Docs, Slides and Forms to</h3>
        <p className="text-sm text-ink-3">Paste folder, shared drive or spreadsheet links or IDs, one per line. Leave all three empty to allow everything the Google account can reach.</p>
        <div className="grid gap-3 lg:grid-cols-3">
          {([["folders", "Folders"], ["sharedDrives", "Shared drives"], ["spreadsheets", "Spreadsheets"]] as const).map(([key, label]) => (
            <div key={key} className="space-y-1">
              <Label htmlFor={`${id}-${key}`}>{label}</Label>
              <Textarea id={`${id}-${key}`} value={draft[key]} rows={4} className="font-mono text-xs" onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
              <p className="text-xs text-ink-3">{parseGoogleIdList(draft[key]).length} ID(s)</p>
            </div>
          ))}
        </div>
      </div>
      <div className="max-w-md space-y-1">
        <Label htmlFor={`${id}-domain`}>Your Google Workspace domain</Label>
        <Input id={`${id}-domain`} value={draft.domain} placeholder="example.com" onChange={(event) => setDraft({ ...draft, domain: event.target.value })} />
        <p className="text-sm text-ink-3">Sharing inside this domain counts as editing; sharing outside it or sending email follows the policy above.</p>
      </div>
      {save.isError && <p role="alert" className="text-sm text-bad">{save.error instanceof Error ? save.error.message : "Settings could not be saved."}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" disabled={!dirty || save.isPending} onClick={() => settings.data && setDraft(draftFrom(settings.data.settings))}>Discard</Button>
        <Button disabled={!dirty || save.isPending} onClick={() => save.mutate(draft)}>{save.isPending ? "Saving…" : "Save"}</Button>
      </div>
    </section>
  );
}
