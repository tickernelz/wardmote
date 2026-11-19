import type {
  IssueComment,
  IssueShareLink,
  PublicIssueShareView,
} from "@tickernelz/wardmote-shared";
import { api, ApiError } from "./client";
import { readApiJson } from "./response";

export type IssueCommentPublicShare = IssueComment & { publicShareVisible: boolean };

export type PublicShareState = { view: PublicIssueShareView; etag: string | null };

const PUBLIC_SHARE_BASE = "/api/public/share";

function readEtag(header: string | null) {
  return header?.match(/^(?:W\/)?"([^"]+)"$/)?.[1] ?? null;
}

export function publicShareEventsUrl(token: string, since: string | null) {
  const url = `${PUBLIC_SHARE_BASE}/${encodeURIComponent(token)}/events`;
  return since ? `${url}?since=${encodeURIComponent(since)}` : url;
}

async function getPublicShareView(
  token: string,
  etag: string | null = null,
): Promise<PublicShareState | null | "not-modified"> {
  const res = await fetch(`${PUBLIC_SHARE_BASE}/${encodeURIComponent(token)}`, {
    method: "GET",
    credentials: "omit",
    headers: etag ? { Accept: "application/json", "If-None-Match": `W/"${etag}"` } : { Accept: "application/json" },
  });
  if (res.status === 304) return "not-modified";
  if (res.status === 404) return null;
  const body = await readApiJson<unknown>(res);
  if (!res.ok) {
    throw new ApiError(
      (body as { error?: string } | null)?.error ?? `Request failed: ${res.status}`,
      res.status,
      body,
    );
  }
  return { view: body as PublicIssueShareView, etag: readEtag(res.headers.get("ETag")) };
}

export const issueShareApi = {
  getShareLink: (issueId: string) =>
    api.get<IssueShareLink | null>(`/issues/${issueId}/share-link`),
  createShareLink: (issueId: string) =>
    api.post<IssueShareLink>(`/issues/${issueId}/share-link`, {}),
  revokeShareLink: (issueId: string) =>
    api.delete<void>(`/issues/${issueId}/share-link`),
  setCommentPublicShare: (issueId: string, commentId: string, visible: boolean) =>
    api.patch<IssueCommentPublicShare>(
      `/issues/${issueId}/comments/${commentId}/public-share`,
      { visible },
    ),
  getPublicShare: getPublicShareView,
};
