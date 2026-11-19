import { useState } from "react";
import { PauseCircle } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn, formatDateTime, relativeTime } from "../lib/utils";
import { meaningfulTreeHoldReason, pauseActorName, pauseNoteSummary, type PauseNote } from "../lib/tree-hold-reason";

/** Who paused a task and why, as one truncated line that opens the full reason. */
export function PauseReasonNote({
  note,
  identifier,
  showTime = false,
  detail,
  className,
}: {
  note: PauseNote;
  identifier: string;
  showTime?: boolean;
  detail?: string;
  className?: string;
}) {
  const reason = meaningfulTreeHoldReason(note.reason);
  const who = pauseActorName(note);
  const when = relativeTime(note.pausedAt);
  const summary = pauseNoteSummary(note, showTime ? when : undefined);
  const heading = reason || note.actorKind === "agent" ? `Paused by ${who}` : `Paused manually by ${who}`;
  const [open, setOpen] = useState<boolean | null>(null);
  const trigger = (
    <button
      type="button"
      data-pause-reason={reason ? "given" : "none"}
      title={summary}
      aria-haspopup="dialog"
      aria-expanded={open === true}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={open === null ? () => setOpen(true) : undefined}
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1 rounded-sm text-left text-xs text-ink-2 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-focus",
        className,
      )}
    >
      <PauseCircle aria-hidden="true" className="size-3 shrink-0" />
      <span className="sr-only">Why {identifier} is paused: </span>
      <span className="min-w-0 truncate">{summary}</span>
    </button>
  );
  if (open === null) return trigger;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 max-w-[calc(100vw-2rem)] p-3 text-sm"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <p className="font-medium text-ink">{heading}</p>
        <p className="text-xs text-ink-3">
          <time dateTime={new Date(note.pausedAt).toISOString()}>{formatDateTime(note.pausedAt)}</time> · {when}
        </p>
        {reason ? (
          <p data-testid="pause-reason-text" className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-ink">{reason}</p>
        ) : (
          <p className="mt-2 text-ink-3">No reason was given.</p>
        )}
        {detail ? <p className="mt-2 text-xs text-ink-3">{detail}</p> : null}
      </PopoverContent>
    </Popover>
  );
}
