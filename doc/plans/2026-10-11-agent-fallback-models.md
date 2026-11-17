# Agent fallback models

Date: 2026-10-11
Scope: adapter `omp_local` (all 16 production agents). Other adapters ignore the setting.

## Why

Over seven days production runs failed with `omp_transient_upstream` 74 times, `omp_provider_quota` 5 times and
`omp_model_refusal` 5 times. Wardmote retried each one on the same model. OMP already knows how to move a session to
another model when a turn hits a retryable provider error, but no agent had a fallback chain configured.

## Decisions

1. **Setting.** `adapterConfig.fallbackModels` is an ordered list of at most 5 OMP model selectors for the main model
   only (smol/slow/plan get no fallback). An empty or missing list keeps today's behaviour exactly. Entries must be
   distinct and must not equal the primary `model`. The agent config editor edits it with the model picker (display name
   and provider, grouped by provider) with add, remove and reorder. Single-agent edits go through `PATCH /agents/:id`
   (activity `agent.updated`); the list is validated there (`validateAgentFallbackModels` in the shared package).
2. **Batch.** The existing batch model editor (`/agents/batch/adapter-config` preview and apply,
   `BulkAgentAdapterConfigDialog`) gains `fallbackModels` as a list field. Modes: replace the list on every selected
   agent, or clear it. Per agent, a candidate equal to that agent's primary is dropped and the preview says so; agents
   whose adapter does not support fallback are listed as skipped. Apply logs `agent.updated` per agent as before.
3. **Triggers.** Rate limit or quota, upstream failures (overload, 5xx, timeout, dropped connection) and model refusal.
   Never auth errors or context-length errors.
4. **In-run switching is OMP's.** The run's settings overlay (`--config`) carries
   `retry.fallbackChains: { "<start model>": [rest of the chain] }`, `retry.modelFallback: true` and
   `retry.fallbackRevertPolicy: cooldown-expiry`. OMP suppresses the failing selector for its retry-after (else its
   backoff, 5 min for unknown reasons), switches mid-turn, emits `retry_fallback_applied` and restores the primary
   when the suppression expires.
5. **Refusal is Wardmote's.** OMP does not fall back on refusals, so a run failing with `omp_model_refusal` is retried
   by Wardmote on the next candidate. The refused selector is excluded only for that retry chain
   (`contextSnapshot.wardmoteModelFallbackExcluded`); no company cooldown is written because refusals depend on content.
6. **Cross-run cooldown.** Table `model_cooldowns` (company_id, selector, cooldown_until, reason, source_run_id),
   unique per company and selector, because provider limits are shared by every agent using a selector. Writes keep the
   later expiry. A cooldown is recorded when OMP reports an in-run fallback (retry-after parsed from the preceding
   `auto_retry_start` error, else 5 min) and when a run fails with quota/transient (`retryNotBefore`, else 5 min).
7. **Start model.** The chain is `[primary, ...fallbackModels]` with duplicates removed; a task model override becomes
   the primary and the agent list follows it. Excluded selectors are dropped. A run starts on the first selector that is
   not cooling down; if all are cooling, on the one that expires first. The overlay chain lists the remaining selectors,
   free ones first, cooling ones last, so OMP can still reach the primary inside the run.
8. **Retry after a failed run.** quota/transient record the cooldown and use the existing bounded retry. When a
   non-cooling candidate exists the retry runs at the base backoff instead of waiting for the failed model's
   retry-after, and starts on that candidate. When every candidate is cooling, the existing retry timing is unchanged.
   Refusal schedules the same bounded retry when a non-excluded candidate is left.
9. **Exhaustion.** When the run gives up (refusal with no candidate left, or the bounded retry budget is spent) on an
   agent with a fallback chain, a `model.fallback_exhausted` run event is written. Attention derives a `failed_run`
   item from it (dedup key `run:<id>`), which clears when a later run of the same agent succeeds.
10. **Thinking level.** Nothing new: OMP clamps the requested thinking level to what the chosen model supports at
    startup (`resolveThinkingLevelForModel`) and on fallback (`clampThinkingLevelToCeiling` plus the model floor).

## Overlay merge finding

OMP loads `--config` overlays after global and project settings and merges them with `#deepMerge`
(`config/settings.ts`): plain objects merge key by key, arrays and scalars replace. `retry.fallbackChains` is a
record, so the overlay adds the agent's key and the owner's existing chains (for example `web`) stay in effect. Only a
user chain keyed by the same selector is replaced by the agent's list.

## Limitation

OMP's restore-to-primary only applies after a switch OMP made inside the same process; there is no setting or flag to
seed a suppression or an active fallback at startup. A run that Wardmote starts on a fallback because the primary is
cooling stays on that fallback (or moves further down the chain) for the rest of that run; the next run starts on the
primary once its cooldown has expired or a probe released it.

## Cooldown prober (2026-11-17, ZHA-6645)

Since 2026-10-15 (148b81832e) a fresh wake ignored cooldowns and always started on the primary. Measured on the
production instance for 2026-11-10..17: 118 in-run switches, all with OMP's 5 min default (no provider retry-after);
36 runs started on a primary that had switched away less than 5 min earlier and spent 6,510 s in total (p50 53 s,
p90 545 s) on it before OMP moved on. A fresh wake again starts on the first chain selector that is not cooling (the
primary when all are cooling; the overlay keeps the configured order), and a prober keeps a recovered model from
waiting out the rest of its cooldown:

- `model_cooldowns.probe_after` is the write time for a default cooldown and null when the provider named its wait;
  only rows with a `probe_after` before `cooldown_until` are probed, never before `probe_after`.
- The probe is `omp bench <selector> --runs 1 --par 1 --max-tokens 1 --prompt ping --json` through the adapter's
  `probeModel`, with the source run's agent config resolved like a run (secrets included), so endpoint and
  credentials match the run. Measured: 2.1 s and $0.0000123 on `sub2api-deepseek/deepseek-flash`, 2.1 s and $0.0028
  on `sub2api-claude/claude-opus-5-5`; `omp -p` took 88.9 s and was rejected. Later runs of the same deepseek-flash
  probe measured 17-88 s TTFT and 28-51 output tokens (a reasoning model ignores the one-token cap for its thinking),
  so the probe timeout is 60 s, the same as the probation first-event limit. A failing provider costs about 32 s
  (OMP's HTTP client retries 503s). One probe process: 315-385 MB RSS, 1.2-1.5 s CPU; at most 2 run at once.
- Schedule, success rule, hourly limit, release compare-and-set on `updated_at`, events and the 10 min probation with a
  60 s first-event limit are described in `docs/fork/OPERATIONS.md` (Fallback models).
- The prober is in-process (`server/src/services/model-cooldown-prober.ts`), one per database; streak and hourly
  counts restart from zero after a server restart, the schedule itself is rebuilt from the table.

## Events and visibility

- Run event `model.fallback` (stream system, level warn) per switch, payload
  `{ phase: "run_start" | "in_run", from, to, primary, reason, retryAfterMs }`, reason `rate_limit | upstream | refusal`.
  The adapter emits the `in_run` event; the server writes the `run_start` event when a run starts off-primary.
- `model.fallback_restored` when OMP returns to the primary inside the run.
- `contextSnapshot.wardmoteModelFallback: RunModelFallbackState | null` (`primaryModel, activeModel, reason, switchedAt`)
  is kept current during the run and exposed as `modelFallback` on the live-runs payloads (`LiveRunForIssue`).
- The Live now card shows `Fallback: <name> · <provider> (primary: rate limit)`; the run transcript shows a line per
  switch.
- Activity `issue.run_model_fallback` on the issue per switch, details `{ runId, agentId, from, to, reason, phase }`.
- `model.cooldown_released` run event and `issue.run_model_cooldown_released` activity when probes end a cooldown;
  `model.primary_probation` run event on a run that starts on a model released within 10 min.
- The in-run `model.fallback` payload carries `retryAfterSource: "provider" | "default"`.
