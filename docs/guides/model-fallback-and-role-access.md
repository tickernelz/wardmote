# Model fallback and role-based access

## Model fallback inside a run (`omp_local`)

An agent with `fallbackModels` runs OMP with `retry.fallbackChains` keyed by its start model. Wardmote adds three rules on top of OMP's own retry logic.

### Retry the same model before moving on

The per-run OMP extension (`wardmote-tool-guard.js`) keeps every other chain model suppressed in OMP's model registry while the active model fails with a transient error, so OMP retries the same model with its normal backoff (`retry.baseDelayMs` is 4000 ms for agents with a chain) and honours `Retry-After`.

| Error on the active model | What happens |
| --- | --- |
| 503 `No available accounts`, 5xx, overloaded, timeout, first-event timeout, gateway concurrency cap | Retried on the same model; the chain opens after 2 failed attempts in a row (3 for a model on probation). |
| Refusal, 429/quota/usage limit, auth error, context too long | The chain opens at once and OMP switches. |
| Any successful response | The failure count resets and the chain closes again. |
| OMP gives up the retry (`auto_retry_end` without success) | The hold is released, so the next turn can switch at once. |

One OMP attempt already includes the provider transport's own retries (about 30 s of 503 responses in a measured run), so a dead primary costs about one minute before the switch.

### Classification and cooldown

The fallback event is classified from the error text OMP puts on `retry_fallback_applied`, which OMP emits before `auto_retry_start`. The `model.fallback` run event, the run's live fallback state and the activity entry carry `errorKind` (`no_accounts`, `refusal`, `timeout`, `concurrency_limit`, `rate_limit`, `upstream`) and the first 200 characters of the provider error.

| Kind | Company cooldown of the model left |
| --- | --- |
| `refusal` | None: a refusal belongs to the request, not the model. |
| `concurrency_limit` | The provider's `Retry-After`, else 30 s; no probe. |
| `rate_limit` with `Retry-After` | Until the provider's time; no probe. |
| Everything else | 5 minutes, released early by the cooldown prober. |

### Probation after a restore

A model a user restored with *Back to primary model*, or the prober released, starts its next run on probation. Its first-response limit (60 s) applies only while that model is the active one: the extension sets OMP's first-event timeout environment for the probation model and restores the previous value as soon as the run switches to another model.

### Cooldown prober

The prober does not ping a cooling model while a running run of the same company uses a model of the same provider, and it does not count a gateway concurrency-cap reply as a failed probe. Both cases wait 30 s and try again.

## Access by task type

Every run gets the `full` tool profile and the agent's trust preset; neither depends on the task's origin. What differs by task type is listed below.

| Task / wake | OpenWA sender class | OpenWA tools | Read or cancel another agent's decision |
| --- | --- | --- | --- |
| WhatsApp conversation task, owner message | `owner` | Yes, origin chat | Origin agent or CEO |
| WhatsApp conversation task, non-owner message | `non_owner`: message text is data, replies follow the chat's reply policy | Yes, origin chat | Origin agent or CEO |
| WhatsApp conversation task, wake without a chat message (task completion, card answer, monitor, comment) | `owner` when the server records an owner origin (owner DM, owner-only group, task handed off by an owner run), else `non_owner` | Yes, origin chat | Origin agent or CEO |
| Child task of a WhatsApp conversation, any wake | `owner` | Yes, through the conversation | Origin agent or CEO |
| Manual, routine, watchdog or bridge task outside any conversation, CEO agent assigned to an OpenWA endpoint, run requested by an endpoint owner | `owner` | Yes, anchored on that requester's own owner DM | Origin agent or CEO |
| Same, run requested by a non-owner or with no requester | not applicable | No | Origin agent or CEO |
| Same, any other agent | not applicable | No | Origin agent only |

The role is read from the agent row on the server. A message, task text or tool argument never changes it, and on a WhatsApp conversation task the sender classification above still decides what a non-owner's words can do.

Boundaries that stay with people whatever the role: relaying an owner's card answer needs that owner's chat message, and a blocked issue names the agent's own id as unblock owner.
