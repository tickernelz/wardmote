import { createHash } from "node:crypto";
import {
  diffPublicIssueShareView,
  type LiveEvent,
  type PublicIssueShareView,
} from "@tickernelz/wardmote-shared";
import { subscribeAllCompanyLiveEvents } from "./live-events.js";
import type { ResolvedIssueShare } from "./issue-share-links.js";

export const SHARE_LIVE_LIMITS = {
  streamsPerToken: 250,
  streamsPerIp: 20,
  streams: 2_000,
};

const TICK_MS = 5_000;
const PING_EVERY_TICKS = 4;
const RESYNC_EVERY_TICKS = 60;
const COALESCE_MS = 150;
const MAX_BUFFERED_BYTES = 1_048_576;
const ISSUE_EVENT_TYPES = new Set(["activity.logged", "heartbeat.run.status", "heartbeat.run.queued"]);

export function publicShareViewEtag(json: string) {
  return createHash("sha1").update(json).digest("base64url");
}

export interface ShareLiveSink {
  write(chunk: string): void;
  end(): void;
  bufferedBytes(): number;
}

type Stream = { sink: ShareLiveSink; ip: string; since: string | null; pending: boolean };

type Channel = {
  token: string;
  issueId: string;
  streams: Set<Stream>;
  view: PublicIssueShareView | null;
  viewJson: string;
  etag: string | null;
  building: boolean;
  dirty: boolean;
  closed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

export type ShareLiveLimit = "token" | "ip" | "server";

export interface IssueShareLiveHub {
  limitFor(token: string, ip: string): ShareLiveLimit | null;
  attach(resolved: ResolvedIssueShare, ip: string, since: string | null, sink: ShareLiveSink): () => void;
  close(): void;
  stats(): { channels: number; streams: number };
}

function sse(event: string, id: string | null, data: string) {
  return `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${data}\n\n`;
}

function isLoopback(ip: string) {
  return ip === "::1" || ip.startsWith("127.") || ip.startsWith("::ffff:127.");
}

function issueIdOf(event: LiveEvent): string | null {
  if (!ISSUE_EVENT_TYPES.has(event.type)) return null;
  const issueId = event.payload.issueId;
  return typeof issueId === "string" ? issueId : null;
}

export function createIssueShareLiveHub(deps: {
  resolve(token: string): Promise<ResolvedIssueShare | null>;
  liveTokens(tokens: string[]): Promise<Set<string>>;
  buildView(resolved: ResolvedIssueShare): Promise<PublicIssueShareView>;
  subscribe?: (listener: (event: LiveEvent) => void) => () => void;
  limits?: Partial<typeof SHARE_LIVE_LIMITS>;
  tickMs?: number;
  coalesceMs?: number;
  onError?: (error: unknown) => void;
}): IssueShareLiveHub {
  const limits = { ...SHARE_LIVE_LIMITS, ...deps.limits };
  const tickMs = deps.tickMs ?? TICK_MS;
  const coalesceMs = deps.coalesceMs ?? COALESCE_MS;
  const subscribe = deps.subscribe ?? subscribeAllCompanyLiveEvents;
  const byToken = new Map<string, Channel>();
  const byIssue = new Map<string, Set<Channel>>();
  const perIp = new Map<string, number>();
  let streamCount = 0;
  let ticks = 0;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let checkingTokens = false;

  function report(error: unknown) {
    deps.onError?.(error);
  }

  function initial(channel: Channel, stream: Stream) {
    stream.pending = false;
    const message = stream.since === channel.etag
      ? sse("ready", channel.etag, JSON.stringify({ etag: channel.etag }))
      : sse("view", channel.etag, `{"etag":${JSON.stringify(channel.etag)},"view":${channel.viewJson}}`);
    send(channel, stream, message);
  }

  function send(channel: Channel, stream: Stream, message: string) {
    if (stream.sink.bufferedBytes() > MAX_BUFFERED_BYTES) {
      detach(channel, stream);
      stream.sink.end();
      return;
    }
    stream.sink.write(message);
  }

  function publish(channel: Channel, view: PublicIssueShareView) {
    const viewJson = JSON.stringify(view);
    const etag = publicShareViewEtag(viewJson);
    const previous = channel.view;
    const base = channel.etag;
    const changed = etag !== base;
    channel.view = view;
    channel.viewJson = viewJson;
    channel.etag = etag;
    const patch = previous && base && changed
      ? sse("patch", etag, JSON.stringify({ base, etag, patch: diffPublicIssueShareView(previous, view) }))
      : null;
    for (const stream of [...channel.streams]) {
      if (stream.pending) initial(channel, stream);
      else if (patch) send(channel, stream, patch);
    }
  }

  function closeChannel(channel: Channel, event: "gone" | null) {
    if (channel.closed) return;
    channel.closed = true;
    if (channel.timer) clearTimeout(channel.timer);
    channel.timer = null;
    for (const stream of [...channel.streams]) {
      detach(channel, stream);
      if (event) stream.sink.write(sse(event, null, "{}"));
      stream.sink.end();
    }
    forget(channel);
  }

  function forget(channel: Channel) {
    if (byToken.get(channel.token) === channel) byToken.delete(channel.token);
    const siblings = byIssue.get(channel.issueId);
    siblings?.delete(channel);
    if (siblings && siblings.size === 0) byIssue.delete(channel.issueId);
  }

  async function refresh(channel: Channel, first: ResolvedIssueShare | null = null) {
    if (channel.building) {
      channel.dirty = true;
      return;
    }
    channel.building = true;
    let resolved = first;
    try {
      do {
        channel.dirty = false;
        resolved ??= await deps.resolve(channel.token);
        if (channel.closed) return;
        if (!resolved || resolved.root.id !== channel.issueId) {
          closeChannel(channel, "gone");
          return;
        }
        const view = await deps.buildView(resolved);
        if (channel.closed) return;
        publish(channel, view);
        resolved = null;
      } while (channel.dirty && !channel.closed);
    } catch (error) {
      report(error);
      if (!channel.view) closeChannel(channel, null);
    } finally {
      channel.building = false;
    }
  }

  function schedule(channel: Channel) {
    if (channel.timer || channel.closed) return;
    channel.timer = setTimeout(() => {
      channel.timer = null;
      void refresh(channel);
    }, coalesceMs);
  }

  function onEvent(event: LiveEvent) {
    const issueId = issueIdOf(event);
    if (!issueId) return;
    const channels = byIssue.get(issueId);
    if (!channels) return;
    for (const channel of channels) schedule(channel);
  }

  async function checkTokens() {
    if (checkingTokens || byToken.size === 0) return;
    checkingTokens = true;
    try {
      const tokens = [...byToken.keys()];
      const live = await deps.liveTokens(tokens);
      for (const token of tokens) {
        const channel = byToken.get(token);
        if (channel && !live.has(token)) closeChannel(channel, "gone");
      }
    } catch (error) {
      report(error);
    } finally {
      checkingTokens = false;
    }
  }

  function tick() {
    ticks += 1;
    void checkTokens();
    if (ticks % PING_EVERY_TICKS === 0) {
      const ping = sse("ping", null, "0");
      for (const channel of byToken.values()) {
        for (const stream of [...channel.streams]) {
          if (!stream.pending) send(channel, stream, ping);
        }
      }
    }
    if (ticks % RESYNC_EVERY_TICKS === 0) {
      for (const channel of byToken.values()) schedule(channel);
    }
  }

  function start() {
    if (ticker) return;
    unsubscribe = subscribe(onEvent);
    ticker = setInterval(tick, tickMs);
    ticker.unref?.();
  }

  function stop() {
    if (ticker) clearInterval(ticker);
    ticker = null;
    unsubscribe?.();
    unsubscribe = null;
    ticks = 0;
  }

  function detach(channel: Channel, stream: Stream) {
    if (!channel.streams.delete(stream)) return;
    streamCount -= 1;
    const count = (perIp.get(stream.ip) ?? 1) - 1;
    if (count > 0) perIp.set(stream.ip, count);
    else perIp.delete(stream.ip);
    if (channel.streams.size === 0) closeChannel(channel, null);
    if (streamCount === 0) stop();
  }

  return {
    limitFor(token, ip) {
      if (streamCount >= limits.streams) return "server";
      if ((byToken.get(token)?.streams.size ?? 0) >= limits.streamsPerToken) return "token";
      if (!isLoopback(ip) && (perIp.get(ip) ?? 0) >= limits.streamsPerIp) return "ip";
      return null;
    },
    attach(resolved, ip, since, sink) {
      const token = resolved.link.token;
      let channel = byToken.get(token);
      const created = !channel;
      if (!channel) {
        channel = {
          token,
          issueId: resolved.root.id,
          streams: new Set(),
          view: null,
          viewJson: "",
          etag: null,
          building: false,
          dirty: false,
          closed: false,
          timer: null,
        };
        byToken.set(token, channel);
        const siblings = byIssue.get(channel.issueId) ?? new Set<Channel>();
        siblings.add(channel);
        byIssue.set(channel.issueId, siblings);
      }
      const stream: Stream = { sink, ip, since, pending: true };
      channel.streams.add(stream);
      streamCount += 1;
      perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
      start();
      if (created) void refresh(channel, resolved);
      else if (channel.view) initial(channel, stream);
      const owner = channel;
      return () => detach(owner, stream);
    },
    close() {
      for (const channel of [...byToken.values()]) closeChannel(channel, null);
      stop();
    },
    stats() {
      return { channels: byToken.size, streams: streamCount };
    },
  };
}
