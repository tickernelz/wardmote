export const GOOGLE_WORKSPACE_API_VERSIONS = {
  drive: "v3",
  sheets: "v4",
  docs: "v1",
  slides: "v1",
  calendar: "v3",
  gmail: "v1",
  forms: "v1",
  tasks: "v1",
  chat: "v1",
  meet: "v2",
  people: "v1",
  script: "v1",
} as const;

export type GoogleWorkspaceService = keyof typeof GOOGLE_WORKSPACE_API_VERSIONS;
export const GOOGLE_WORKSPACE_SERVICE_IDS = Object.keys(GOOGLE_WORKSPACE_API_VERSIONS) as GoogleWorkspaceService[];

export const GOOGLE_WORKSPACE_TIERS = ["off", "read", "edit", "create", "delete_share"] as const;
export type GoogleWorkspaceTier = (typeof GOOGLE_WORKSPACE_TIERS)[number];

export const GOOGLE_WORKSPACE_POLICY_ACTIONS = ["allow", "require_approval", "block"] as const;
export type GoogleWorkspacePolicyAction = (typeof GOOGLE_WORKSPACE_POLICY_ACTIONS)[number];

export const GOOGLE_WORKSPACE_POLICY_CLASSES = ["write", "destructive", "external", "execute", "unreviewed"] as const;
export type GoogleWorkspacePolicyClass = (typeof GOOGLE_WORKSPACE_POLICY_CLASSES)[number];

export const GOOGLE_WORKSPACE_DEFAULT_CLASS_POLICY: Readonly<Record<GoogleWorkspacePolicyClass, GoogleWorkspacePolicyAction>> = {
  write: "allow",
  destructive: "require_approval",
  external: "require_approval",
  execute: "block",
  unreviewed: "require_approval",
};

const g = (scope: string) => `https://www.googleapis.com/auth/${scope}`;

type TierScopes = Readonly<Record<Exclude<GoogleWorkspaceTier, "off">, readonly string[]>>;

function tiers(read: string[], edit: string[], create: string[], deleteShare: string[]): TierScopes {
  return { read: read.map(g), edit: edit.map(g), create: create.map(g), delete_share: deleteShare.map(g) };
}

export const GOOGLE_WORKSPACE_IDENTITY_SCOPES = ["openid", g("userinfo.email")] as const;

export const GOOGLE_WORKSPACE_TIER_SCOPES: Readonly<Record<GoogleWorkspaceService, TierScopes>> = {
  drive: tiers(["drive.readonly"], ["drive.readonly", "drive.file"], ["drive.readonly", "drive.file"], ["drive"]),
  sheets: tiers(["spreadsheets.readonly"], ["spreadsheets"], ["spreadsheets"], ["spreadsheets"]),
  docs: tiers(["documents.readonly"], ["documents"], ["documents"], ["documents"]),
  slides: tiers(["presentations.readonly"], ["presentations"], ["presentations"], ["presentations"]),
  calendar: tiers(["calendar.readonly"], ["calendar.events"], ["calendar.events"], ["calendar"]),
  gmail: tiers(["gmail.readonly"], ["gmail.modify"], ["gmail.modify", "gmail.compose"], ["gmail.modify", "gmail.compose", "gmail.send"]),
  forms: tiers(["forms.body.readonly", "forms.responses.readonly"], ["forms.body", "forms.responses.readonly"], ["forms.body", "forms.responses.readonly"], ["forms.body", "forms.responses.readonly"]),
  tasks: tiers(["tasks.readonly"], ["tasks"], ["tasks"], ["tasks"]),
  chat: tiers(
    ["chat.spaces.readonly", "chat.messages.readonly"],
    ["chat.spaces.readonly", "chat.messages"],
    ["chat.spaces.create", "chat.messages"],
    ["chat.spaces", "chat.messages", "chat.memberships"],
  ),
  meet: tiers(["meetings.space.readonly"], ["meetings.space.created"], ["meetings.space.created"], ["meetings.space.created"]),
  people: tiers(["contacts.readonly", "directory.readonly"], ["contacts", "directory.readonly"], ["contacts", "directory.readonly"], ["contacts", "directory.readonly"]),
  script: tiers(["script.projects.readonly"], ["script.projects"], ["script.projects"], ["script.projects", "script.deployments"]),
};

export interface GoogleWorkspaceScopeLimits {
  driveFolderIds: string[];
  sharedDriveIds: string[];
  spreadsheetIds: string[];
}

export interface GoogleWorkspaceSettings {
  capabilities: Record<GoogleWorkspaceService, GoogleWorkspaceTier>;
  classPolicy: Record<GoogleWorkspacePolicyClass, GoogleWorkspacePolicyAction>;
  methodOverrides: Record<string, GoogleWorkspacePolicyAction>;
  scope: GoogleWorkspaceScopeLimits;
  domain: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function oneOf<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T) : fallback;
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(item)))] : [];
}

export function normalizeGoogleWorkspaceSettings(value: unknown): GoogleWorkspaceSettings {
  const input = record(value);
  const capabilities = record(input.capabilities);
  const classPolicy = record(input.classPolicy);
  const scope = record(input.scope);
  const methodOverrides: Record<string, GoogleWorkspacePolicyAction> = {};
  for (const [method, action] of Object.entries(record(input.methodOverrides))) {
    if (/^[a-z]+(\.[A-Za-z0-9]+)+(#[A-Za-z]+)?$/.test(method) && (GOOGLE_WORKSPACE_POLICY_ACTIONS as readonly string[]).includes(String(action))) {
      methodOverrides[method] = action as GoogleWorkspacePolicyAction;
    }
  }
  const domain = typeof input.domain === "string" && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(input.domain) ? input.domain.toLowerCase() : null;
  return {
    capabilities: Object.fromEntries(
      GOOGLE_WORKSPACE_SERVICE_IDS.map((service) => [service, oneOf(GOOGLE_WORKSPACE_TIERS, capabilities[service], "off")]),
    ) as Record<GoogleWorkspaceService, GoogleWorkspaceTier>,
    classPolicy: Object.fromEntries(
      GOOGLE_WORKSPACE_POLICY_CLASSES.map((name) => [name, oneOf(GOOGLE_WORKSPACE_POLICY_ACTIONS, classPolicy[name], GOOGLE_WORKSPACE_DEFAULT_CLASS_POLICY[name])]),
    ) as Record<GoogleWorkspacePolicyClass, GoogleWorkspacePolicyAction>,
    methodOverrides,
    scope: { driveFolderIds: ids(scope.driveFolderIds), sharedDriveIds: ids(scope.sharedDriveIds), spreadsheetIds: ids(scope.spreadsheetIds) },
    domain,
  };
}

export function googleWorkspaceScopesFor(capabilities: Partial<Record<GoogleWorkspaceService, GoogleWorkspaceTier>>): string[] {
  const scopes = new Set<string>(GOOGLE_WORKSPACE_IDENTITY_SCOPES);
  for (const service of GOOGLE_WORKSPACE_SERVICE_IDS) {
    const tier = capabilities[service] ?? "off";
    if (tier === "off") continue;
    for (const scope of GOOGLE_WORKSPACE_TIER_SCOPES[service][tier]) scopes.add(scope);
  }
  return [...scopes];
}
