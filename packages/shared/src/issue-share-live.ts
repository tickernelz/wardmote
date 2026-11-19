import type {
  PublicIssueSharePatch,
  PublicIssueShareView,
  PublicShareListPatch,
} from "./types/issue-share.js";

type Keyed<T> = (item: T) => string;

const byId = (item: { id: string }) => item.id;
const byKey = (item: { key: string }) => item.key;

export class PublicSharePatchMismatchError extends Error {
  constructor() {
    super("Public share patch does not match the current view");
  }
}

function applyList<T>(previous: T[], patch: PublicShareListPatch<T> | undefined, keyOf: Keyed<T>): T[] {
  if (!patch) return previous;
  const upserts = new Map((patch.upsert ?? []).map((item) => [keyOf(item), item]));
  if (patch.order) {
    const previousByKey = new Map(previous.map((item) => [keyOf(item), item]));
    return patch.order.map((key) => {
      const item = upserts.get(key) ?? previousByKey.get(key);
      if (item === undefined) throw new PublicSharePatchMismatchError();
      return item;
    });
  }
  const removed = new Set(patch.remove ?? []);
  const next: T[] = [];
  const placed = new Set<string>();
  for (const item of previous) {
    const key = keyOf(item);
    if (removed.has(key)) continue;
    next.push(upserts.get(key) ?? item);
    placed.add(key);
  }
  for (const [key, item] of upserts) {
    if (!placed.has(key)) next.push(item);
  }
  return next;
}

function diffList<T>(previous: T[], next: T[], keyOf: Keyed<T>): PublicShareListPatch<T> | undefined {
  const previousJson = new Map(previous.map((item) => [keyOf(item), JSON.stringify(item)]));
  const nextKeys = new Set(next.map(keyOf));
  const upsert = next.filter((item) => previousJson.get(keyOf(item)) !== JSON.stringify(item));
  const remove = previous.map(keyOf).filter((key) => !nextKeys.has(key));
  const patch: PublicShareListPatch<T> = {};
  if (upsert.length > 0) patch.upsert = upsert;
  if (remove.length > 0) patch.remove = remove;
  const implied = applyList(previous, patch, keyOf).map(keyOf);
  const order = next.map(keyOf);
  if (implied.length !== order.length || implied.some((key, index) => key !== order[index])) patch.order = order;
  return patch.upsert || patch.remove || patch.order ? patch : undefined;
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function diffPublicIssueShareView(
  previous: PublicIssueShareView,
  next: PublicIssueShareView,
): PublicIssueSharePatch {
  const patch: PublicIssueSharePatch = {};
  if (!sameJson(previous.company, next.company)) patch.company = next.company;
  const issue: Partial<PublicIssueShareView["issue"]> = {};
  for (const key of Object.keys(next.issue) as Array<keyof PublicIssueShareView["issue"]>) {
    if (!sameJson(previous.issue[key], next.issue[key])) {
      (issue as Record<string, unknown>)[key] = next.issue[key];
    }
  }
  if (Object.keys(issue).length > 0) patch.issue = issue;
  if (!sameJson(previous.activeRun, next.activeRun)) patch.activeRun = next.activeRun;
  const comments = diffList(previous.comments, next.comments, byId);
  if (comments) patch.comments = comments;
  const documents = diffList(previous.documents, next.documents, byKey);
  if (documents) patch.documents = documents;
  const attachments = diffList(previous.attachments, next.attachments, byId);
  if (attachments) patch.attachments = attachments;
  const workProducts = diffList(previous.workProducts, next.workProducts, byId);
  if (workProducts) patch.workProducts = workProducts;
  return patch;
}

export function applyPublicIssueSharePatch(
  view: PublicIssueShareView,
  patch: PublicIssueSharePatch,
): PublicIssueShareView {
  return {
    company: patch.company ?? view.company,
    issue: patch.issue ? { ...view.issue, ...patch.issue } : view.issue,
    activeRun: "activeRun" in patch ? patch.activeRun ?? null : view.activeRun,
    comments: applyList(view.comments, patch.comments, byId),
    documents: applyList(view.documents, patch.documents, byKey),
    attachments: applyList(view.attachments, patch.attachments, byId),
    workProducts: applyList(view.workProducts, patch.workProducts, byId),
  };
}
