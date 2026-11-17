export const GOOGLE_WORKSPACE_ERROR_CODES = [
  "validation",
  "capability_off",
  "out_of_scope",
  "approval_required",
  "scope_missing",
  "api_not_enabled",
  "auth_expired",
  "rate_limited",
  "google_error",
] as const;

export type GoogleWorkspaceErrorCode = (typeof GOOGLE_WORKSPACE_ERROR_CODES)[number];

export class GoogleWorkspaceError extends Error {
  readonly code: GoogleWorkspaceErrorCode;
  readonly hint: string;
  readonly details: Record<string, unknown>;

  constructor(code: GoogleWorkspaceErrorCode, message: string, hint: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "GoogleWorkspaceError";
    this.code = code;
    this.hint = hint;
    this.details = details;
  }

  toJSON() {
    return { ok: false, code: this.code, message: this.message, hint: this.hint, ...this.details };
  }
}
