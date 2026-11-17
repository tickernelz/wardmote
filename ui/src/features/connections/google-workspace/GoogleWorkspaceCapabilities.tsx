import {
  GOOGLE_WORKSPACE_SERVICE_IDS,
  GOOGLE_WORKSPACE_TIER_SCOPES,
  GOOGLE_WORKSPACE_TIERS,
  googleWorkspaceScopeClass,
  googleWorkspaceScopesFor,
  type GoogleWorkspaceService,
  type GoogleWorkspaceTier,
} from "@tickernelz/wardmote-shared";
import { Segmented, SegmentedItem } from "@/components/ui/segmented";
import { NativeSelect } from "@/components/ui/select";

export const GOOGLE_WORKSPACE_SERVICE_LABELS: Record<GoogleWorkspaceService, string> = {
  drive: "Drive",
  sheets: "Sheets",
  docs: "Docs",
  slides: "Slides",
  calendar: "Calendar",
  gmail: "Gmail",
  forms: "Forms",
  tasks: "Tasks",
  chat: "Chat",
  meet: "Meet",
  people: "Contacts",
  script: "Apps Script",
};

export const GOOGLE_WORKSPACE_TIER_LABELS: Record<GoogleWorkspaceTier, string> = {
  off: "Off",
  read: "Read",
  edit: "Edit",
  create: "Create & upload",
  delete_share: "Delete & share",
};

const SCOPE_PREFIX = "https://www.googleapis.com/auth/";

function shortScope(scope: string): string {
  return scope.startsWith(SCOPE_PREFIX) ? scope.slice(SCOPE_PREFIX.length) : scope;
}

export function googleWorkspaceServiceScopes(service: GoogleWorkspaceService, tier: GoogleWorkspaceTier): readonly string[] {
  return tier === "off" ? [] : GOOGLE_WORKSPACE_TIER_SCOPES[service][tier];
}

function ScopeClass({ scopes }: { scopes: readonly string[] }) {
  if (scopes.length === 0) return null;
  const restricted = scopes.some((scope) => googleWorkspaceScopeClass(scope) === "restricted");
  return restricted
    ? <span className="shrink-0 rounded-full border border-warn bg-warn-soft px-2 py-0.5 text-xs leading-4 font-medium text-ink">restricted</span>
    : <span className="shrink-0 rounded-full border border-line-strong px-2 py-0.5 text-xs leading-4 text-ink-2">sensitive</span>;
}

export function GoogleWorkspaceCapabilities({
  capabilities,
  onChange,
  disabled,
}: {
  capabilities: Partial<Record<GoogleWorkspaceService, GoogleWorkspaceTier>>;
  onChange: (service: GoogleWorkspaceService, tier: GoogleWorkspaceTier) => void;
  disabled?: boolean;
}) {
  const scopes = googleWorkspaceScopesFor(capabilities);
  const restricted = scopes.filter((scope) => googleWorkspaceScopeClass(scope) === "restricted");
  return (
    <div className="space-y-4">
      <div className="@container/gws-levels">
        <ul className="grid grid-cols-(--gtc-13) divide-y divide-line rounded-lg border border-line" aria-label="Google service levels">
          {GOOGLE_WORKSPACE_SERVICE_IDS.map((service) => {
            const tier = capabilities[service] ?? "off";
            const serviceScopes = googleWorkspaceServiceScopes(service, tier);
            const labelId = `gws-tier-${service}`;
            return (
              <li key={service} className="col-span-full grid grid-cols-subgrid items-center gap-x-4 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span id={labelId} className="font-medium">{GOOGLE_WORKSPACE_SERVICE_LABELS[service]}</span>
                    <ScopeClass scopes={serviceScopes} />
                  </div>
                  <p className="break-words font-mono text-xs text-ink-3">
                    {serviceScopes.length ? serviceScopes.map(shortScope).join(", ") : "no access"}
                  </p>
                </div>
                <Segmented aria-labelledby={labelId} className="hidden @2xl/gws-levels:inline-flex">
                  {GOOGLE_WORKSPACE_TIERS.map((option) => (
                    <SegmentedItem
                      key={option}
                      selected={tier === option}
                      disabled={disabled}
                      onClick={() => onChange(service, option)}
                    >
                      {GOOGLE_WORKSPACE_TIER_LABELS[option]}
                    </SegmentedItem>
                  ))}
                </Segmented>
                <NativeSelect
                  aria-labelledby={labelId}
                  value={tier}
                  disabled={disabled}
                  onChange={(event) => onChange(service, event.target.value as GoogleWorkspaceTier)}
                  className="w-40 border-line-strong @2xl/gws-levels:hidden"
                >
                  {GOOGLE_WORKSPACE_TIERS.map((option) => (
                    <option key={option} value={option}>{GOOGLE_WORKSPACE_TIER_LABELS[option]}</option>
                  ))}
                </NativeSelect>
              </li>
            );
          })}
        </ul>
      </div>
      {(capabilities.drive ?? "off") === "delete_share" && (
        <div role="note" className="rounded-lg border border-warn bg-warn-soft p-3 text-sm text-ink">
          <p className="font-medium">Drive “Delete & share” asks Google for the restricted drive scope.</p>
          <p className="text-ink-2">Without it agents can only change files they create through Wardmote (drive.file). Deleting and sharing still go through an approval card.</p>
        </div>
      )}
      <p className="text-sm text-ink-3" aria-live="polite">
        Wardmote will ask Google for {scopes.length} scopes{restricted.length ? `, ${restricted.length} of them restricted (${restricted.map(shortScope).join(", ")})` : ""}. Unverified apps can request about 25. Raising a level later asks Google only for the added scopes.
      </p>
    </div>
  );
}
