# Image task recovery · 任务继续与恢复

Inspect the Task in its original data root first. Tasks do not persist prompts; do not reconstruct the user's input from a task summary. Inspection has no provider side effects. Observe or recover only as needed for the current request.

For ComfyUI and mixed API work, see [workflow and recovery details](comfyui.md). Keep each stage's original Task. A persistent Flow uses its original Run/Operation and binding; do not use a standalone retry to change that Flow's model or template.

| Recorded fact | Action |
|---|---|
| Accepted and still queued/running | Observe or wait for the original Task; do not create another generation |
| `outcome=succeeded`, `deliveryState=ready` | Retrieve existing Artifacts and export as needed |
| `outcome=succeeded`, `deliveryState=failed` | Redeliver the original result, preferring a complete local cache |
| Unknown acceptance/outcome, or an Attempt without a reliable response | Preserve the original Task and uncertainty; do not infer that no work or billing occurred |
| User requests stopping | Stop subsequent generation; remote cancellation succeeds only with protocol support and provider confirmation |
| User knowingly requests retrying a terminal task without successful delivery | Create a linked new Task with possible additional billing, preserving the original |

An unfinished Attempt with `acceptance=none` does not prove that nothing was sent. Local timeout, CLI interruption, and stopping a local wait do not establish successful remote cancellation.

## Observe and wait · 观察与等待

Use the original provider binding. A single observation advances at most one poll:

```bash
dsh-iris task observe "$IRIS_TASK_ID" --data-root "$IRIS_DATA_ROOT" --provider-config "$IRIS_PROVIDER_FILE"
```

Use bounded waiting when needed, adjusting the limit to the user's task:

```bash
dsh-iris task wait "$IRIS_TASK_ID" --data-root "$IRIS_DATA_ROOT" --provider-config "$IRIS_PROVIDER_FILE" --timeout-ms 120000 --poll-interval-ms 2500
```

Observation and waiting do not resubmit or create a background loop. Terminal inspection needs no provider configuration. Report protocols without remote observation support. `task wait` exits 0 for ready, 1 for unsuccessful delivery, and 3 for timeout; timeout preserves the original task facts.

## Redeliver · 补交付

```bash
dsh-iris task redeliver "$IRIS_TASK_ID" --data-root "$IRIS_DATA_ROOT" --provider-config "$IRIS_PROVIDER_FILE"
```

Recover the original result only when the Task state permits it. A complete cache can deliver offline; missing bytes may require retrieving the original remote result. Verify the original provider/model binding without switching to the current candidate pool or regenerating.

## Cancel · 取消

```bash
dsh-iris task cancel "$IRIS_TASK_ID" --data-root "$IRIS_DATA_ROOT" --provider-config "$IRIS_PROVIDER_FILE"
```

Execute only when the task state and protocol permit it. Report unsupported or unconfirmed cancellation accurately instead of claiming that remote work was revoked.

## Retry with informed authorization · 知情重试

Use this operation after the user has authorized a retry with possible duplicate billing; do not ask again for authorization already given. Supply the prompt again in the input file, and the original `source_artifact_id` for an edit:

```bash
dsh-iris task retry "$IRIS_TASK_ID" --data-root "$IRIS_DATA_ROOT" --provider-config "$IRIS_PROVIDER_FILE" --confirm-billing --input-file "$IRIS_INPUT_FILE"
```

This creates a new Task with `retriedFrom`, leaving the original intact. `--confirm-billing` is a standalone switch with no following value. Specify a retry model with the outer `--model-ref` flag, not the `model_ref` field used by `run image` input.

A busy root, stale lease, or mismatched binding is an execution gap. This skill does not delete leases, take over writers, migrate data, or reset configuration.
