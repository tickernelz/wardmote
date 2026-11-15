import type { DashboardRunActivityDay, HeartbeatRun } from "@tickernelz/wardmote-shared";
import { cn } from "../lib/utils";

/* ---- Utilities ---- */

export function getLast14Days(): string[] {
  return Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (13 - i));
    return d.toISOString().slice(0, 10);
  });
}

function formatDayLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function emptyRunDay(date: string): DashboardRunActivityDay {
  return { date, succeeded: 0, failed: 0, recovered: 0, other: 0, total: 0, failedByErrorCode: {} };
}

const runSegmentColors = {
  succeeded: "var(--status-task-icon-done)",
  recovered: "var(--status-task-todo)",
  failed: "var(--status-task-icon-blocked)",
  other: "var(--hex-737373)",
} as const;

// Compact per-day tooltip that also attributes failures to their error class.
function runDayTooltip(entry: DashboardRunActivityDay): string {
  const lines = [`${entry.date}: ${entry.total} run${entry.total === 1 ? "" : "s"}`];
  if (entry.succeeded > 0) lines.push(`  succeeded: ${entry.succeeded}`);
  if (entry.recovered > 0) lines.push(`  recovered: ${entry.recovered} (retry succeeded)`);
  if (entry.failed > 0) {
    lines.push(`  failed: ${entry.failed}`);
    const codes = Object.entries(entry.failedByErrorCode ?? {}).sort((a, b) => b[1] - a[1]);
    for (const [code, count] of codes) lines.push(`    ${code}: ${count}`);
  }
  if (entry.other > 0) lines.push(`  other: ${entry.other}`);
  return lines.join("\n");
}

/* ---- Sub-components ---- */

function DateLabels({ days }: { days: string[] }) {
  return (
    <div className="flex gap-(--sz-3px) mt-1.5">
      {days.map((day, i) => (
        <div key={day} className="flex-1 text-center">
          {(i === 0 || i === 6 || i === 13) ? (
            <span className="text-(length:--text-nano) text-ink-3 tabular-nums">{formatDayLabel(day)}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ChartLegend({ items }: { items: { color: string; label: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 mt-2">
      {items.map(item => (
        <span key={item.label} className="flex items-center gap-1 text-(length:--text-nano) text-ink-3">
          <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

export function ChartCard({ title, subtitle, className, children }: { title: string; subtitle?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("border border-line rounded-lg p-4 space-y-3", className)}>
      <div>
        <h3 className="text-xs font-medium text-ink-3">{title}</h3>
        {subtitle && <span className="text-(length:--text-nano) text-ink-3/60">{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

/* ---- Chart Components ---- */

type RunChartProps =
  | { activity?: DashboardRunActivityDay[] | null; runs?: never }
  | { runs?: HeartbeatRun[] | null; activity?: never };

function aggregateRuns(runs: readonly HeartbeatRun[] = []): DashboardRunActivityDay[] {
  const days = getLast14Days();
  const grouped = new Map<string, DashboardRunActivityDay>();
  for (const day of days) grouped.set(day, emptyRunDay(day));
  for (const run of runs) {
    const day = new Date(run.createdAt).toISOString().slice(0, 10);
    const entry = grouped.get(day);
    if (!entry) continue;
    if (run.status === "succeeded") {
      entry.succeeded++;
    } else if (run.status === "failed" || run.status === "timed_out") {
      // A flat run list has no retry-chain linkage, so recovery can't be derived
      // here (the company dashboard computes it server-side). Attribute the
      // failure to its error class so the breakdown still renders.
      entry.failed++;
      const code = run.errorCode && run.errorCode.length > 0 ? run.errorCode : "unknown";
      entry.failedByErrorCode[code] = (entry.failedByErrorCode[code] ?? 0) + 1;
    } else {
      entry.other++;
    }
    entry.total++;
  }
  return Array.from(grouped.values());
}

function resolveRunActivity(props: RunChartProps): DashboardRunActivityDay[] {
  if (Array.isArray(props.activity)) return props.activity;
  if (Array.isArray(props.runs)) return aggregateRuns(props.runs);
  return [];
}

export function RunActivityChart(props: RunChartProps) {
  const activity = resolveRunActivity(props);
  const days = activity.length > 0 ? activity.map((day) => day.date) : getLast14Days();
  const grouped = new Map(activity.map((day) => [day.date, day]));

  const maxValue = Math.max(...activity.map(v => v.total), 1);
  const hasData = activity.some(v => v.total > 0);
  const hasRecovered = activity.some(v => v.recovered > 0);

  if (!hasData) return <p className="text-xs text-ink-3">No runs yet</p>;

  const legendItems = [
    { color: runSegmentColors.succeeded, label: "Succeeded" },
    ...(hasRecovered ? [{ color: runSegmentColors.recovered, label: "Recovered" }] : []),
    { color: runSegmentColors.failed, label: "Failed" },
    { color: runSegmentColors.other, label: "Other" },
  ];

  return (
    <div>
      <div className="flex items-end gap-(--sz-3px) h-20">
        {days.map(day => {
          const entry = grouped.get(day) ?? emptyRunDay(day);
          const total = entry.total;
          const heightPct = (total / maxValue) * 100;
          return (
            <div key={day} className="flex-1 h-full flex flex-col justify-end" title={runDayTooltip(entry)}>
              {total > 0 ? (
                <div className="flex flex-col-reverse gap-px overflow-hidden" style={{ height: `${heightPct}%`, minHeight: 2 }}>
                  {entry.succeeded > 0 && <div style={{ flex: entry.succeeded, backgroundColor: runSegmentColors.succeeded }} />}
                  {entry.recovered > 0 && <div style={{ flex: entry.recovered, backgroundColor: runSegmentColors.recovered }} />}
                  {entry.failed > 0 && <div style={{ flex: entry.failed, backgroundColor: runSegmentColors.failed }} />}
                  {entry.other > 0 && <div style={{ flex: entry.other, backgroundColor: runSegmentColors.other }} />}
                </div>
              ) : (
                <div className="bg-bg-3/30 rounded-sm" style={{ height: 2 }} />
              )}
            </div>
          );
        })}
      </div>
      <DateLabels days={days} />
      <ChartLegend items={legendItems} />
    </div>
  );
}

export function SuccessRateChart(props: RunChartProps) {
  const activity = resolveRunActivity(props);
  const days = activity.length > 0 ? activity.map((day) => day.date) : getLast14Days();
  const grouped = new Map(activity.map((day) => [day.date, day]));

  const hasData = activity.some(v => v.total > 0);
  if (!hasData) return <p className="text-xs text-ink-3">No runs yet</p>;

  return (
    <div>
      <div className="flex items-end gap-(--sz-3px) h-20">
        {days.map(day => {
          const entry = grouped.get(day) ?? emptyRunDay(day);
          // Recovered runs ultimately succeeded, so they count toward the rate
          // rather than dragging it down as failures.
          const effectiveSucceeded = entry.succeeded + entry.recovered;
          const rate = entry.total > 0 ? effectiveSucceeded / entry.total : 0;
          const color = entry.total === 0 ? undefined : rate >= 0.8 ? "var(--status-task-icon-done)" : rate >= 0.5 ? "var(--hex-eab308)" : "var(--status-task-icon-blocked)";
          return (
            <div key={day} className="flex-1 h-full flex flex-col justify-end" title={`${day}: ${entry.total > 0 ? Math.round(rate * 100) : 0}% (${effectiveSucceeded}/${entry.total})`}>
              {entry.total > 0 ? (
                <div style={{ height: `${rate * 100}%`, minHeight: 2, backgroundColor: color }} />
              ) : (
                <div className="bg-bg-3/30 rounded-sm" style={{ height: 2 }} />
              )}
            </div>
          );
        })}
      </div>
      <DateLabels days={days} />
    </div>
  );
}
