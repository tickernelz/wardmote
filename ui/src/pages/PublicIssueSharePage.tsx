import { useCallback, useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  Download,
  ExternalLink,
  Eye,
  FileText,
  Link2Off,
  Lock,
  WifiOff,
} from "lucide-react";
import {
  ISSUE_SHARE_TOKEN_PATTERN,
  type PublicIssueComment,
  type PublicIssueShareView,
  type PublicShareActor,
  type PublicShareAttachment,
  type PublicShareDocument,
  type PublicShareWorkProduct,
} from "@tickernelz/wardmote-shared";
import { Navigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@/components/ui/attachment";
import { CompanyPatternIcon } from "@/components/CompanyPatternIcon";
import { Identity } from "@/components/Identity";
import { MarkdownBody } from "@/components/MarkdownBody";
import { IssueStatusBadge } from "@/components/StatusBadge";
import { PriorityIcon } from "@/components/PriorityIcon";
import {
  fileKindForAttachment,
  formatFileSize,
} from "@/components/task-chat/task-chat-attachments";
import { issueShareApi } from "../api/issue-share";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDateTime, relativeTime } from "../lib/utils";

const ACTIVE_RUN_REFETCH_MS = 15_000;

const FOCUS_RING =
  "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
const ACTION_LINK = cn(
  FOCUS_RING,
  "inline-flex min-h-6 items-center gap-1.5 rounded-sm text-(length:--t-13) font-medium text-ink-2 underline-offset-4 hover:text-ink hover:underline pointer-coarse:min-h-11",
);
const SHELL = "mx-auto w-full max-w-5xl px-4 sm:px-6";

function useNoIndexMeta() {
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex";
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
}

function useDocumentTitle(title: string | null) {
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}

const ATTACHMENT_CONTENT_SRC = /^(?:https?:\/\/[^/]+)?\/api\/attachments\/([^/?#]+)\/content(?:[?#].*)?$/i;

function publicShareImageSrc(token: string, src: string): string | null {
  const match = ATTACHMENT_CONTENT_SRC.exec(src.trim());
  if (!match) return null;
  return `/api/public/share/${encodeURIComponent(token)}/attachments/${match[1]}/content`;
}

function humanize(value: string) {
  const text = value.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="flex items-baseline gap-2 text-(length:--t-14) font-semibold text-ink">
        {title}
        {count !== undefined ? <span className="text-(length:--t-12) font-normal text-ink-3">{count}</span> : null}
      </h2>
      {children}
    </section>
  );
}

function ActorIdentity({ actor }: { actor: PublicShareActor }) {
  return <Identity name={actor.name} avatarUrl={actor.iconUrl} size="sm" />;
}

function Timestamp({ value }: { value: string }) {
  return (
    <time dateTime={value} title={formatDateTime(value)} className="text-(length:--t-12) text-ink-3">
      {relativeTime(value)}
    </time>
  );
}

function ActiveRunPill({ agentName }: { agentName: string }) {
  return (
    <span
      data-testid="public-share-run-pill"
      className="inline-flex items-center gap-2 rounded-full border border-line bg-bg-2 px-3 py-1 text-(length:--t-12) text-ink"
    >
      <span className="size-2 rounded-full bg-(--status-agent-running) motion-safe:animate-pulse" aria-hidden />
      {agentName} is working…
    </span>
  );
}

function AttachmentList({ attachments }: { attachments: PublicShareAttachment[] }) {
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {attachments.map((attachment) => {
        const kind = fileKindForAttachment({
          name: attachment.filename,
          url: attachment.url,
          contentType: attachment.contentType,
          byteSize: attachment.byteSize,
        });
        const KindIcon = kind.icon;
        const size = formatFileSize(attachment.byteSize);
        return (
          <li key={attachment.id} className="min-w-0">
            <Attachment size="sm" className="w-full rounded-md focus-within:ring-2 focus-within:ring-focus">
              <AttachmentMedia>
                <KindIcon aria-hidden />
              </AttachmentMedia>
              <AttachmentContent className="min-w-0 flex-1">
                <AttachmentTitle>{attachment.filename}</AttachmentTitle>
                <AttachmentDescription>{size ? `${kind.label} · ${size}` : kind.label}</AttachmentDescription>
              </AttachmentContent>
              <AttachmentTrigger
                aria-label={`Download ${attachment.filename}`}
                render={<a href={attachment.url} download={attachment.filename} rel="noreferrer" />}
              />
            </Attachment>
          </li>
        );
      })}
    </ul>
  );
}

type ImageSrcResolver = (src: string) => string | null;

function TimelineEntry({ comment, resolveImageSrc }: { comment: PublicIssueComment; resolveImageSrc: ImageSrcResolver }) {
  if (comment.kind === "redacted") {
    return (
      <li
        data-testid="public-share-redacted-comment"
        className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-dashed border-line px-4 py-2.5"
      >
        <Lock className="size-3.5 shrink-0 text-ink-3" aria-hidden />
        <ActorIdentity actor={comment.author} />
        <span className="text-(length:--t-12) text-ink-3">Internal update</span>
        <Timestamp value={comment.createdAt} />
      </li>
    );
  }
  return (
    <li className="rounded-lg border border-line bg-bg-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line-soft px-4 py-2.5">
        <ActorIdentity actor={comment.author} />
        <Timestamp value={comment.createdAt} />
      </div>
      <div className="space-y-3 px-4 py-3">
        <MarkdownBody className="text-(length:--t-14)" softBreaks linkIssueReferences={false} resolveImageSrc={resolveImageSrc}>
          {comment.body}
        </MarkdownBody>
        {comment.attachments.length > 0 ? <AttachmentList attachments={comment.attachments} /> : null}
      </div>
    </li>
  );
}

function DocumentCard({ document, resolveImageSrc }: { document: PublicShareDocument; resolveImageSrc: ImageSrcResolver }) {
  return (
    <details className="group rounded-lg border border-line bg-bg-2">
      <summary
        className={cn(
          FOCUS_RING,
          "flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-lg px-4 py-2 text-(length:--t-14) hover:bg-bg-3/50 [&::-webkit-details-marker]:hidden",
        )}
      >
        <ChevronRight
          className="size-4 shrink-0 text-ink-3 group-open:rotate-90 motion-safe:transition-transform"
          aria-hidden
        />
        <FileText className="size-4 shrink-0 text-ink-3" aria-hidden />
        <span className="min-w-0 flex-1 break-words font-medium">{document.title ?? document.key}</span>
        <Timestamp value={document.updatedAt} />
      </summary>
      <div className="space-y-4 border-t border-line px-4 py-4">
        <MarkdownBody className="text-(length:--t-14)" linkIssueReferences={false} resolveImageSrc={resolveImageSrc}>
          {document.body}
        </MarkdownBody>
        <a href={document.pdfUrl} download rel="noreferrer" className={ACTION_LINK}>
          <Download className="size-4" aria-hidden />
          Download PDF
        </a>
      </div>
    </details>
  );
}

function WorkProductRow({ product }: { product: PublicShareWorkProduct }) {
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-line bg-bg-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <p className="break-words text-(length:--t-14) font-medium">{product.title}</p>
        <p className="text-(length:--t-12) text-ink-3">
          {humanize(product.type)} · {humanize(product.status)}
        </p>
      </div>
      {product.url || product.downloadUrl ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {product.url ? (
            <a href={product.url} target="_blank" rel="noopener noreferrer" className={ACTION_LINK}>
              <ExternalLink className="size-4" aria-hidden />
              Open
              <span className="sr-only">{` ${product.title}, opens in a new tab`}</span>
            </a>
          ) : null}
          {product.downloadUrl ? (
            <a href={product.downloadUrl} download rel="noreferrer" className={ACTION_LINK}>
              <Download className="size-4" aria-hidden />
              Download
              <span className="sr-only">{` ${product.title}`}</span>
            </a>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-(length:--t-12) text-ink-3">{label}</dt>
      <dd className="min-w-0 break-words text-(length:--t-13) text-ink">{children}</dd>
    </div>
  );
}

function ShareHeader({ company }: { company: PublicIssueShareView["company"] | null }) {
  return (
    <header className="border-b border-line bg-bg-2">
      <div className={cn(SHELL, "flex min-h-14 items-center gap-3 py-2")}>
        {company ? (
          <>
            <CompanyPatternIcon
              companyName={company.name}
              logoUrl={company.logoUrl}
              logoFit="contain"
              className="size-8 shrink-0 rounded-md"
            />
            <span className="min-w-0 truncate text-(length:--t-14) font-semibold">{company.name}</span>
          </>
        ) : (
          <span className="text-(length:--t-14) font-semibold">Wardmote</span>
        )}
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-(length:--t-12) text-ink-2">
          <Eye className="size-3.5" aria-hidden />
          Read-only
        </span>
      </div>
    </header>
  );
}

function CenteredNotice({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-bg text-ink">
      <ShareHeader company={null} />
      <main className="flex flex-1 items-center px-4 py-10">
        <div className="mx-auto w-full max-w-md space-y-3 rounded-lg border border-line bg-bg-2 p-6 text-center">
          <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-bg-3 text-ink-2" aria-hidden>
            {icon}
          </div>
          <h1 className="text-(length:--t-16) font-semibold text-balance">{title}</h1>
          <p className="text-(length:--t-14) text-ink-2 text-pretty">{body}</p>
          {action}
        </div>
      </main>
    </div>
  );
}

function PublicIssueShareContent({ view, token }: { view: PublicIssueShareView; token: string }) {
  const { company, issue } = view;
  const resolveImageSrc = useCallback((src: string) => publicShareImageSrc(token, src), [token]);
  return (
    <div className="flex min-h-dvh flex-col bg-bg text-ink">
      <ShareHeader company={company} />
      <main className={cn(SHELL, "flex-1 space-y-8 py-6 sm:py-10")}>
        <div className="space-y-3">
          {issue.identifier || issue.projectName ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-(length:--t-13) text-ink-3">
              {issue.identifier ? <span className="font-mono">{issue.identifier}</span> : null}
              {issue.identifier && issue.projectName ? <span aria-hidden>·</span> : null}
              {issue.projectName ? <span>{issue.projectName}</span> : null}
            </p>
          ) : null}
          <h1 className="break-words text-(length:--t-20) font-semibold leading-tight text-balance sm:text-(length:--t-24)">
            {issue.title}
          </h1>
          {view.activeRun ? <ActiveRunPill agentName={view.activeRun.agentName} /> : null}
        </div>
        <div className="grid gap-8 lg:grid-cols-3 lg:gap-10">
          <aside aria-label="Task details" className="lg:order-last">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-4 rounded-lg border border-line bg-bg-2 p-4 sm:grid-cols-3 lg:sticky lg:top-6 lg:grid-cols-1">
              <Property label="Status">
                <IssueStatusBadge status={issue.status} />
              </Property>
              <Property label="Priority">
                <PriorityIcon priority={issue.priority} showLabel />
              </Property>
              <Property label="Assignee">
                {issue.assignee ? <ActorIdentity actor={issue.assignee} /> : <span className="text-ink-3">Unassigned</span>}
              </Property>
              <Property label="Created">
                <time dateTime={issue.createdAt}>{formatDateTime(issue.createdAt)}</time>
              </Property>
              <Property label="Updated">
                <time dateTime={issue.updatedAt} title={formatDateTime(issue.updatedAt)}>
                  {relativeTime(issue.updatedAt)}
                </time>
              </Property>
              {issue.completedAt ? (
                <Property label="Completed">
                  <time dateTime={issue.completedAt}>{formatDateTime(issue.completedAt)}</time>
                </Property>
              ) : null}
            </dl>
          </aside>
          <div className="min-w-0 space-y-10 lg:col-span-2">
            {issue.description ? (
              <MarkdownBody
                className="text-(length:--t-14) sm:text-(length:--t-16)"
                softBreaks
                linkIssueReferences={false}
                resolveImageSrc={resolveImageSrc}
              >
                {issue.description}
              </MarkdownBody>
            ) : null}
            {view.documents.length > 0 ? (
              <Section title="Documents" count={view.documents.length}>
                <div className="space-y-2">
                  {view.documents.map((document) => (
                    <DocumentCard key={document.key} document={document} resolveImageSrc={resolveImageSrc} />
                  ))}
                </div>
              </Section>
            ) : null}
            {view.attachments.length > 0 ? (
              <Section title="Attachments" count={view.attachments.length}>
                <AttachmentList attachments={view.attachments} />
              </Section>
            ) : null}
            {view.workProducts.length > 0 ? (
              <Section title="Work products" count={view.workProducts.length}>
                <ul className="space-y-2">
                  {view.workProducts.map((product) => (
                    <WorkProductRow key={product.id} product={product} />
                  ))}
                </ul>
              </Section>
            ) : null}
            <Section title="Activity" count={view.comments.length > 0 ? view.comments.length : undefined}>
              {view.comments.length > 0 ? (
                <ol className="space-y-3">
                  {view.comments.map((comment) => (
                    <TimelineEntry key={comment.id} comment={comment} resolveImageSrc={resolveImageSrc} />
                  ))}
                </ol>
              ) : (
                <p className="text-(length:--t-14) text-ink-3">No updates yet.</p>
              )}
            </Section>
          </div>
        </div>
      </main>
      <footer className="border-t border-line">
        <p className={cn(SHELL, "py-5 text-(length:--t-12) text-ink-3 text-pretty")}>
          Read-only view of one task, shared by {company.name || "its team"}. Anyone with this link can see it.
        </p>
      </footer>
    </div>
  );
}

function LoadingShell() {
  return (
    <div className="flex min-h-dvh flex-col bg-bg text-ink" aria-busy="true">
      <ShareHeader company={null} />
      <main className={cn(SHELL, "flex-1 space-y-8 py-6 sm:py-10")}>
        <p role="status" className="sr-only">Loading shared task…</p>
        <div className="space-y-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-7 w-3/4" />
        </div>
        <div className="grid gap-8 lg:grid-cols-3 lg:gap-10">
          <Skeleton className="h-28 w-full lg:order-last" />
          <div className="space-y-3 lg:col-span-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-24 w-full" />
          </div>
        </div>
      </main>
    </div>
  );
}

export function PublicShareUnavailable() {
  return (
    <CenteredNotice
      icon={<Link2Off className="size-5" />}
      title="This link is not available"
      body="The task may no longer be shared, or the address is incomplete. Ask the person who sent it for a new link."
    />
  );
}

export function PublicIssueShareLegacyRedirect() {
  const { token = "" } = useParams<{ token: string }>();
  return <Navigate to={`/s/${encodeURIComponent(token)}`} replace />;
}

export function PublicIssueSharePage() {
  const { token = "" } = useParams<{ token: string }>();
  useNoIndexMeta();
  const tokenValid = ISSUE_SHARE_TOKEN_PATTERN.test(token);
  const query = useQuery({
    queryKey: queryKeys.publicShare.view(token),
    queryFn: () => issueShareApi.getPublicShare(token),
    enabled: tokenValid,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: (current) => (current.state.data?.activeRun ? ACTIVE_RUN_REFETCH_MS : false),
  });
  useDocumentTitle(query.data?.issue.title ?? null);

  if (!tokenValid || query.data === null) return <PublicShareUnavailable />;

  if (query.data) return <PublicIssueShareContent view={query.data} token={token} />;

  if (query.isError) {
    return (
      <CenteredNotice
        icon={<WifiOff className="size-5" />}
        title="Couldn't load this task"
        body="Check your connection and try again."
        action={
          <Button variant="secondary" className="mt-2 min-h-11" onClick={() => void query.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }

  return <LoadingShell />;
}
