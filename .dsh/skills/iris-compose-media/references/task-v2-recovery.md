# Iris Task v2 recovery

Read this reference only after a generation tool has returned a Task, or when the user asks about retrying, cancelling, recovering, or delivering an existing Task.

## Keep the identities separate

- A **Task** represents one user-authorized artifact request.
- A **Provider Attempt** is an internal candidate submission inside that Task.
- Automatic failover may create another Provider Attempt only while acceptance is explicitly `not_accepted`; it does not authorize a new Task.
- A new Task is a new potentially billable user operation. Create it only for the original requested artifact or after explicit, informed retry/iteration approval.

## Decide from facts

| Observed fact | Agent action | Forbidden action |
|---|---|---|
| `acceptance=not_accepted` | Let Iris continue its bounded provider failover inside the same Task | Creating a replacement Task merely to imitate failover |
| accepted or `acceptance=unknown` | Preserve the Task ID and stop new generation | Resubmitting to another provider/model |
| queued/running | Observe the existing Task only when the next step depends on it | Claiming the artifact exists or starting a duplicate |
| `watching_paused` / observation failure | Tell the user to resume/re-observe the same Task in the Iris workbench | Starting generation again |
| succeeded but delivery unavailable | Tell the user to retry delivery for the same Task in the Iris workbench | Regenerating the media |
| `needs_attention` / outcome unknown | Report the known facts and request human review | Guessing failure, success, or billing outcome |
| cancellation requested/unknown | Stop downstream work and preserve the Task ID | Treating cancellation as proof that the provider did no work |
| terminal failure with known non-acceptance | Report failure and the exhausted attempts | Silently starting a new Task |
| terminal result reviewed and user explicitly requests another version | Create at most one additional Task unless the user sets a larger bound | Treating review itself as approval to regenerate |

`iris_task_status` observes the existing Task. If an action is not exposed as an Iris Agent tool, direct the user to the existing Task in the Iris workbench; never simulate recovery by calling a generation tool again.

## Report uncertainty

Always include the Task ID, last observed state, acceptance/outcome knowledge, whether a remote operation may still be active, and the exact safe next action. Do not collapse “could not observe” into “generation failed.”
