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
    ? <span className="rounded-full border border-warn bg-warn-soft px-2 py-0.5 text-xs font-medium text-ink">restricted</span>
    : <span className="rounded-full border border-line-strong px-2 py-0.5 text-xs text-ink-2">sensitive</span>;
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
      <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Google service levels">
        {GOOGLE_WORKSPACE_SERVICE_IDS.map((service) => {
          const tier = capabilities[service] ?? "off";
          const serviceScopes = googleWorkspaceServiceScopes(service, tier);
          const labelId = `gws-tier-${service}`;
          return (
            <li key={service} className="flex flex-col gap-2 p-3 lg:flex-row lg:items-center lg:gap-4">
              <div className="flex items-center gap-2 lg:w-44 lg:shrink-0">
                <span id={labelId} className="font-medium">{GOOGLE_WORKSPACE_SERVICE_LABELS[service]}</span>
                <ScopeClass scopes={serviceScopes} />
              </div>
              <Segmented aria-labelledby={labelId} className="flex max-w-full flex-wrap">
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
              <span className="min-w-0 break-words font-mono text-xs text-ink-3 lg:ml-auto lg:text-right">
                {serviceScopes.length ? serviceScopes.map(shortScope).join(", ") : "no access"}
              </span>
            </li>
          );
        })}
      </ul>
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
