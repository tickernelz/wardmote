import { useId, useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink, Upload } from "lucide-react";
import {
  GOOGLE_WORKSPACE_ENABLE_API_IDS,
  GOOGLE_WORKSPACE_SERVICE_IDS,
  parseGoogleClientSecretJson,
  type GoogleClientSecretProblem,
  type GoogleWorkspaceService,
  type GoogleWorkspaceSettingsInput,
  type GoogleWorkspaceTier,
} from "@tickernelz/wardmote-shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCopyAction } from "@/lib/use-copy-action";
import { cn } from "@/lib/utils";
import { GoogleWorkspaceCapabilities } from "./GoogleWorkspaceCapabilities";

export const GOOGLE_WORKSPACE_SETUP_STEPS = ["Who uses it", "Google Cloud", "Credentials", "Capabilities", "Test"] as const;

export const GOOGLE_WORKSPACE_DEFAULT_CAPABILITIES: Partial<Record<GoogleWorkspaceService, GoogleWorkspaceTier>> = {
  sheets: "edit",
  docs: "edit",
  calendar: "read",
  tasks: "read",
};

export interface GoogleWorkspaceSetupDraft {
  capabilities: Partial<Record<GoogleWorkspaceService, GoogleWorkspaceTier>>;
  domain: string;
}

const CLIENT_ID_PATTERN = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;
const DOMAIN_PATTERN = /^[a-z0-9.-]+\.[a-z]{2,}$/i;

const PROBLEM_TEXT: Record<GoogleClientSecretProblem, string> = {
  not_json: "This file is not JSON. Download the client again from Google Cloud > Clients.",
  no_client: "No OAuth client found in this file.",
  installed_client: "This is a Desktop client. Create a Web application client instead.",
  missing_secret: "The file has no client secret.",
  redirect_uri_missing: "The file's redirect URIs do not include this instance's callback URI. Add it to the client, then download the file again.",
};

export function googleWorkspaceSettingsInput(draft: GoogleWorkspaceSetupDraft): GoogleWorkspaceSettingsInput {
  const domain = draft.domain.trim().toLowerCase();
  return {
    capabilities: Object.fromEntries(GOOGLE_WORKSPACE_SERVICE_IDS.map((service) => [service, draft.capabilities[service] ?? "off"])),
    domain: domain || null,
  };
}

export function googleWorkspaceEnableApisUrl(): string {
  const ids = GOOGLE_WORKSPACE_SERVICE_IDS.map((service) => GOOGLE_WORKSPACE_ENABLE_API_IDS[service]).join(",");
  return `https://console.cloud.google.com/flows/enableapi?apiid=${ids}`;
}

export function googleWorkspaceGcloudCommand(): string {
  const ids = GOOGLE_WORKSPACE_SERVICE_IDS.map((service) => GOOGLE_WORKSPACE_ENABLE_API_IDS[service]);
  return `gcloud services enable ${ids.join(" ")} --project=PROJECT_ID`;
}

function Stepper({ current }: { current: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm @lg/gws:gap-x-4" aria-label="Setup steps">
      {GOOGLE_WORKSPACE_SETUP_STEPS.map((label, index) => (
        <li
          key={label}
          aria-current={index === current ? "step" : undefined}
          className={cn("flex items-center gap-1.5", index === current ? "font-semibold text-ink" : index < current ? "text-ink-2" : "text-ink-3")}
        >
          <span className={cn("flex size-5 items-center justify-center rounded-full border text-xs", index < current ? "border-accent bg-accent text-bg" : index === current ? "border-ink" : "border-line-strong")}>
            {index < current ? <Check className="size-3" aria-hidden="true" /> : index + 1}
          </span>
          <span className={index === current ? undefined : "sr-only @lg/gws:not-sr-only"}>{label}</span>
        </li>
      ))}
    </ol>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const { copied, failed, copy } = useCopyAction();
  return (
    <Button type="button" variant="secondary" className="shrink-0" aria-label={label} onClick={() => void copy(value)}>
      {copied ? <Check className="mr-2 size-4" /> : <Copy className="mr-2 size-4" />}
      {copied ? "Copied" : failed ? "Copy failed" : "Copy"}
    </Button>
  );
}

function ConsoleLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line-strong px-2.5 py-1 text-sm font-medium hover:bg-bg-3" href={href} target="_blank" rel="noreferrer">
      {children}
      <ExternalLink className="size-3.5" aria-hidden="true" />
    </a>
  );
}

function CloudStep({ callbackUrl }: { callbackUrl: string }) {
  const items: { title: string; detail: string; href: string; action: string }[] = [
    { title: "Create or pick a Google Cloud project", detail: "Any project you own works; one project can serve every Wardmote connection.", href: "https://console.cloud.google.com/projectcreate", action: "Open Cloud Console" },
    { title: `Enable the ${GOOGLE_WORKSPACE_SERVICE_IDS.length} Workspace APIs`, detail: "One link turns on Drive, Sheets, Docs, Slides, Calendar, Gmail, Forms, Tasks, Chat, Meet, People and Apps Script.", href: googleWorkspaceEnableApisUrl(), action: "Enable APIs" },
    { title: "Set up the consent screen (Audience)", detail: "Google Workspace: choose Internal. Personal Gmail: choose External, then Publish app.", href: "https://console.cloud.google.com/auth/audience", action: "Open Audience" },
    { title: "Create an OAuth client: Web application", detail: "Paste the redirect URI below under Authorized redirect URIs.", href: "https://console.cloud.google.com/auth/clients/create", action: "Create client" },
  ];
  return (
    <div className="grid gap-4 @4xl/gws:grid-cols-2">
      <ol className="space-y-4 rounded-lg border border-line p-4">
        {items.map((item, index) => (
          <li key={item.title} className="flex items-start gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line-strong text-xs">{index + 1}</span>
            <div className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <div className="min-w-0 flex-1 basis-64">
                <p className="font-medium">{item.title}</p>
                <p className="text-sm text-ink-3">{item.detail}</p>
              </div>
              <ConsoleLink href={item.href}>{item.action}</ConsoleLink>
            </div>
          </li>
        ))}
      </ol>
      <div className="space-y-4">
        <div className="space-y-2 rounded-lg border border-line p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Redirect URI</p>
            <CopyButton value={callbackUrl} label="Copy redirect URI" />
          </div>
          <code id="gws-callback" className="block break-all rounded-md bg-bg-2 p-3 font-mono text-xs">{callbackUrl}</code>
          <p className="text-sm text-ink-3">It must match exactly in Google Cloud &gt; Clients &gt; Authorized redirect URIs.</p>
        </div>
        <div role="note" className="rounded-lg border border-warn bg-warn-soft p-4 text-sm">
          <p className="font-medium">Personal Gmail in Testing mode expires every 7 days</p>
          <p className="text-ink-2">Google ends a test user's authorization, refresh token included, seven days after consent. Publish the app (In production) to avoid reconnecting every week.</p>
        </div>
        <div className="space-y-2 rounded-lg border border-line p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Prefer a terminal?</p>
            <CopyButton value={googleWorkspaceGcloudCommand()} label="Copy gcloud command" />
          </div>
          <pre className="whitespace-pre-wrap break-words rounded-md bg-bg-2 p-3 font-mono text-xs">{googleWorkspaceGcloudCommand()}</pre>
        </div>
      </div>
    </div>
  );
}

function CredentialsStep({
  callbackUrl,
  clientId,
  clientSecret,
  onClientIdChange,
  onClientSecretChange,
}: {
  callbackUrl: string;
  clientId: string;
  clientSecret: string;
  onClientIdChange: (value: string) => void;
  onClientSecretChange: (value: string) => void;
}) {
  const fileInputId = useId();
  const [fileProblems, setFileProblems] = useState<GoogleClientSecretProblem[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const readFile = async (file: File | undefined) => {
    if (!file) return;
    const parsed = parseGoogleClientSecretJson(await file.text(), callbackUrl);
    setFileProblems(parsed.problems);
    if (parsed.clientId) onClientIdChange(parsed.clientId);
    if (parsed.clientSecret) onClientSecretChange(parsed.clientSecret);
  };
  const idValid = CLIENT_ID_PATTERN.test(clientId.trim());
  return (
    <div className="grid gap-4 @2xl/gws:grid-cols-2">
      <div className="space-y-4 rounded-lg border border-line p-4">
        <div className="space-y-2">
          <Label htmlFor="gws-client-id">Client ID</Label>
          <Input id="gws-client-id" value={clientId} autoComplete="off" spellCheck={false} className="font-mono text-xs" placeholder="123456789012-abc.apps.googleusercontent.com" onChange={(event) => onClientIdChange(event.target.value.trim())} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="gws-client-secret">Client secret</Label>
          <Input id="gws-client-secret" type="password" value={clientSecret} autoComplete="new-password" className="font-mono text-xs" onChange={(event) => onClientSecretChange(event.target.value.trim())} />
        </div>
        <p className="text-sm text-ink-3">Or</p>
        <label
          htmlFor={fileInputId}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); void readFile(event.dataTransfer.files[0]); }}
          className={cn("flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center text-sm", dragging ? "border-accent bg-accent-soft" : "border-line-strong")}
        >
          <Upload className="size-5 text-ink-3" aria-hidden="true" />
          Drop client_secret.json here or choose the file
          <input id={fileInputId} type="file" accept="application/json,.json" className="sr-only" onChange={(event) => void readFile(event.target.files?.[0])} />
        </label>
      </div>
      <div className="space-y-4">
        <div className="space-y-2 rounded-lg border border-line p-4">
          <p className="font-medium">Checks</p>
          <ul className="space-y-1 text-sm">
            <li className={idValid ? "text-ink" : "text-ink-3"}>{idValid ? "✓" : "•"} Client ID looks like a Google OAuth client</li>
            <li className={clientSecret ? "text-ink" : "text-ink-3"}>{clientSecret ? "✓" : "•"} Client secret entered</li>
            {fileProblems && fileProblems.length === 0 && <li>✓ Client accepts this instance's redirect URI</li>}
            {fileProblems?.map((problem) => <li key={problem} role="alert" className="text-bad">! {PROBLEM_TEXT[problem]}</li>)}
          </ul>
        </div>
        <div role="note" className="rounded-lg border border-line bg-bg-2 p-4 text-sm text-ink-2">
          The secret is stored encrypted and never shown again. Agents never receive the secret or Google tokens; every Google call goes through the Wardmote server.
        </div>
      </div>
    </div>
  );
}

export function GoogleWorkspaceSetup({
  defaults,
  callbackUrl,
  clientId,
  clientSecret,
  onClientIdChange,
  onClientSecretChange,
  draft,
  onDraftChange,
  submitting,
  error,
  onBack,
  onConnect,
}: {
  defaults?: ReactNode;
  callbackUrl: string;
  clientId: string;
  clientSecret: string;
  onClientIdChange: (value: string) => void;
  onClientSecretChange: (value: string) => void;
  draft: GoogleWorkspaceSetupDraft;
  onDraftChange: (draft: GoogleWorkspaceSetupDraft) => void;
  submitting: boolean;
  error: string | null;
  onBack: () => void;
  onConnect: () => void;
}) {
  const [step, setStep] = useState(0);
  const [hasFile, setHasFile] = useState(false);
  const anyService = Object.values(draft.capabilities).some((tier) => tier && tier !== "off");
  const domainValid = !draft.domain.trim() || DOMAIN_PATTERN.test(draft.domain.trim());
  const credentialsReady = CLIENT_ID_PATTERN.test(clientId.trim()) && clientSecret.length > 0;
  const next = () => setStep((value) => Math.min(value + 1, 3));
  const back = () => (step === 0 ? onBack() : setStep((value) => (value === 2 && hasFile ? 0 : value - 1)));
  const setTier = (service: GoogleWorkspaceService, tier: GoogleWorkspaceTier) =>
    onDraftChange({ ...draft, capabilities: { ...draft.capabilities, [service]: tier } });
  return (
    <section className="@container/gws mx-auto max-w-4xl space-y-6" aria-labelledby="gws-setup-title">
      <h2 id="gws-setup-title" className="sr-only">Connect Google Workspace</h2>
      <Stepper current={step} />
      {step === 0 && (
        <div className="space-y-4">
          <div className="grid gap-3 @xl/gws:grid-cols-2" role="radiogroup" aria-label="How do you connect?">
            {[{ file: false, title: "Your own Google OAuth app", detail: "Wardmote links the right Google Cloud pages and fills in the redirect URI; you paste the Client ID and secret." },
              { file: true, title: "I already have client_secret.json", detail: "Upload the OAuth client file from Google Cloud; Wardmote reads it and checks the redirect URI." }].map((option) => (
              <button
                key={option.title}
                type="button"
                role="radio"
                aria-checked={hasFile === option.file}
                onClick={() => setHasFile(option.file)}
                className={cn("rounded-lg border p-4 text-left", hasFile === option.file ? "border-accent bg-accent-soft" : "border-line hover:bg-bg-2")}
              >
                <span className="block font-medium">{option.title}</span>
                <span className="block text-sm text-ink-3">{option.detail}</span>
              </button>
            ))}
          </div>
          {defaults}
        </div>
      )}
      {step === 1 && <CloudStep callbackUrl={callbackUrl} />}
      {step === 2 && (
        <CredentialsStep callbackUrl={callbackUrl} clientId={clientId} clientSecret={clientSecret} onClientIdChange={onClientIdChange} onClientSecretChange={onClientSecretChange} />
      )}
      {step === 3 && (
        <div className="space-y-4">
          <GoogleWorkspaceCapabilities capabilities={draft.capabilities} onChange={setTier} disabled={submitting} />
          <div className="max-w-md space-y-2">
            <Label htmlFor="gws-domain">Your Google Workspace domain (optional)</Label>
            <Input id="gws-domain" value={draft.domain} placeholder="example.com" aria-invalid={!domainValid} onChange={(event) => onDraftChange({ ...draft, domain: event.target.value.trim() })} />
            <p className={cn("text-sm", domainValid ? "text-ink-3" : "text-bad")}>
              {domainValid ? "Sharing inside this domain runs without approval; sharing outside it always asks." : "Enter a domain like example.com."}
            </p>
          </div>
          <p className="text-sm text-ink-3">Step 5 runs after Google sign-in: one cheap read per service you turned on, with a fix link for anything that fails.</p>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="secondary" onClick={back} disabled={submitting}>Back</Button>
        {step < 3 ? (
          <Button type="button" onClick={() => (step === 0 && hasFile ? setStep(2) : step === 2 && !credentialsReady ? undefined : next())} disabled={step === 2 && !credentialsReady}>
            {step === 1 ? "I created the client" : "Continue"}
          </Button>
        ) : (
          <Button type="button" onClick={onConnect} disabled={submitting || !anyService || !domainValid || !credentialsReady}>
            {submitting ? "Connecting…" : "Continue to Google"}
          </Button>
        )}
      </div>
    </section>
  );
}
