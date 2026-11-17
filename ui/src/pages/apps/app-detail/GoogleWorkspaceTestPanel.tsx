import { useId } from "react";
import { useMutation } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import type { GoogleWorkspaceConnectionTest, ToolConnection } from "@tickernelz/wardmote-shared";
import { toolsApi } from "@/api/tools";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GOOGLE_WORKSPACE_SERVICE_LABELS, GOOGLE_WORKSPACE_TIER_LABELS } from "@/features/connections/google-workspace/GoogleWorkspaceCapabilities";

const ACTION_LABELS = { allow: "runs directly", require_approval: "asks for approval", block: "blocked" } as const;

export function GoogleWorkspaceTestResults({ result }: { result: GoogleWorkspaceConnectionTest }) {
  const failed = result.services.filter((service) => !service.ok);
  return (
    <div className="space-y-3">
      <div role="status" className={cn("rounded-lg border p-3 text-sm", result.ok ? "border-ok/40 bg-ok-soft" : "border-bad/40 bg-bad-soft")}>
        <p className="font-medium">
          {result.services.length === 0
            ? "No Google service is turned on."
            : result.ok
              ? `Google Workspace is ready: ${result.services.length} of ${result.services.length} services passed.`
              : `${failed.length} of ${result.services.length} services failed.`}
        </p>
        {!result.ok && result.services.length > 0 && <p className="text-ink-2">The connection is saved. Fix these in Google Cloud and test again; you do not need to sign in again.</p>}
      </div>
      <ul className="divide-y divide-line rounded-lg border border-line">
        {result.services.map((service) => (
          <li key={service.service} className="flex items-start gap-3 p-3">
            <span aria-hidden="true" className={cn("flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold", service.ok ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad")}>
              {service.ok ? "✓" : "!"}
            </span>
            <div className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <div className="min-w-0 flex-1 basis-64 text-sm">
                <p>
                  <span className="font-medium">{GOOGLE_WORKSPACE_SERVICE_LABELS[service.service]}</span>{" "}
                  <span className="text-ink-3">· {GOOGLE_WORKSPACE_TIER_LABELS[service.tier]} · {service.method}</span>
                </p>
                {service.ok
                  ? service.write && <p className="text-ink-3">Dry-run {service.write.method}: {ACTION_LABELS[service.write.action]}</p>
                  : <p className="break-words text-bad">{service.code ? `${service.code}: ` : ""}{service.message}{service.hint ? ` ${service.hint}` : ""}</p>}
              </div>
              {service.enableUrl && (
                <a className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line-strong px-2.5 py-1 text-sm font-medium hover:bg-bg-3" href={service.enableUrl} target="_blank" rel="noreferrer">
                  Enable {GOOGLE_WORKSPACE_SERVICE_LABELS[service.service]} API
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                </a>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function GoogleWorkspaceTestPanel({ connection }: { connection: ToolConnection }) {
  const id = useId();
  const test = useMutation({ mutationFn: () => toolsApi.testGoogleWorkspace(connection.id) });
  return (
    <section className="space-y-4" aria-labelledby={`${id}-title`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id={`${id}-title`} className="text-lg font-semibold">Test Google Workspace</h2>
          <p className="text-sm text-ink-3">One cheap read per service that is turned on, plus a dry-run of a write to show what the policy does.</p>
        </div>
        <Button variant={test.data ? "secondary" : "primary"} disabled={test.isPending || connection.status !== "active"} onClick={() => test.mutate()}>
          {test.isPending ? "Testing…" : test.data ? "Test again" : "Run test"}
        </Button>
      </div>
      {connection.status !== "active" && <p className="text-sm text-ink-3">Finish Google sign-in to test this connection.</p>}
      {test.data && <GoogleWorkspaceTestResults result={test.data} />}
      {test.isError && <p role="alert" className="text-sm text-bad">{test.error instanceof Error ? test.error.message : "The test could not run."}</p>}
    </section>
  );
}
