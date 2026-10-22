# Standalone CLI · 图片与作品

The current executable binding is `dsh-iris`, which uses shared Application/Core operations without a running DSH host. Check the installed command with `dsh-iris --help`. In a confirmed source checkout, `node /absolute/path/to/iris/bin/dsh-iris.js` is also available. A missing command does not authorize installing software or changing package versions.

These image, artifact, and task commands exist in 0.2.6. This skill is a new, unreleased package resource. Development-only Flow commands, local HTTP writes, and a future UI are not prerequisites.

## Establish the context · 明确本次上下文

Obtain these values from the user or already established context:

- `IRIS_DATA_ROOT`: an absolute Core root. Continue each task in its original root.
- `IRIS_PROVIDER_FILE`: a private provider JSON file for generation/editing or remote observation. Import, export, and read-only inspection do not need it.
- `IRIS_INPUT_FILE`: the operation's JSON input file, containing the actual request and necessary parameters.
- `IRIS_TASK_ID` / `IRIS_ARTIFACT_ID`: IDs actually returned by Iris.
- `IRIS_OUTPUT_FILE`: a new absolute output path requested by the user or chosen in the task workspace, with an extension matching the real media type.

Quote these variables in the shell; they are example shell variables, not configuration Iris discovers automatically. Pass request content through a JSON file or stdin instead of inserting user prompts into shell code. Keep private creative input in appropriately protected files without overwriting existing user files.

Do not assume a personal DSH root. Choose a task-specific root for new work when the context permits; changing roots cannot recover an existing task. Use an explicitly supplied provider configuration without printing its credentials.

## Inspect configuration · 查询配置

Read the configured candidate summary when the allowed scope is unclear; do not test configuration by generating:

```bash
dsh-iris capabilities list --provider-config "$IRIS_PROVIDER_FILE"
```

This reports configuration and historical evidence, not remote availability. Report an empty candidate list without adding vendor defaults or expanding the capability pool.

## Import a local image · 导入本地图片

Set `IRIS_INPUT_FILE` to a file containing `{"image_path":"/absolute/path/source.png"}`, then run:

```bash
dsh-iris artifact import --data-root "$IRIS_DATA_ROOT" --input-file "$IRIS_INPUT_FILE"
```

The source must be a static PNG/JPEG/WebP of at most 20 MiB. Keep the returned `artifact.id`, source file, and original bytes. Import does not call a provider or create a generation Task. A host upload must first become a readable file; this CLI does not accept a host attachment ID.

## Generate an image · 生成新图

Write the user's original or authorized revised request into the input file, for example:

```json
{"prompt":"An iris flower after the rain","n":1}
```

```bash
dsh-iris run image --data-root "$IRIS_DATA_ROOT" --provider-config "$IRIS_PROVIDER_FILE" --input-file "$IRIS_INPUT_FILE"
```

Set `n` to the requested count (1–4); do not increase it for testing. Supply `size` only when requested and supported. Omit `model_ref` unless a model was specified; use an allowed `providerId::modelId` for an explicit choice. An explicit choice has no candidate fallback. Default candidate switching requires evidence of non-acceptance.

## Edit an existing image · 编辑已有图片

Use the same `run image` command with the actual source Artifact ID in the input:

```json
{"source_artifact_id":"artifact_0123456789abcdef01234567","prompt":"Make the background green while preserving the subject","n":1}
```

Replace the example ID with a real Artifact in the original root. The source is retained; the new Task's `sourceArtifactId` and new Artifact's `derived-from` relation record its origin. The model must be allowed for images and support an implemented edit protocol. Report an unsupported protocol without substituting a new text-to-image request.

## Inspect tasks and artifacts · 查询原任务和作品

```bash
dsh-iris task inspect "$IRIS_TASK_ID" --data-root "$IRIS_DATA_ROOT"
```

```bash
dsh-iris artifact inspect "$IRIS_ARTIFACT_ID" --data-root "$IRIS_DATA_ROOT"
```

Read the Task's `id`, `acceptance`, `outcome`, `deliveryState`, `artifactIds`, and Attempt facts. Read the Artifact's `id`, `mediaType`, size, digest, and provenance. `outcome=succeeded` with `deliveryState=ready` establishes completed local delivery. A failed operation can still have partial artifacts; preserve them.

These inspections do not call providers, initialize missing roots, or require provider configuration. They do not advance a queued remote task.

If a Task ID was not returned, list the original root's tasks read-only and identify the relevant record:

```bash
dsh-iris task list --data-root "$IRIS_DATA_ROOT" --capability image --limit 20
```

Retain uncertainty when the association is not reliable; the most recent task is not necessarily this request.

## Export an artifact · 导出已有作品

```bash
dsh-iris artifact export "$IRIS_ARTIFACT_ID" --data-root "$IRIS_DATA_ROOT" --output "$IRIS_OUTPUT_FILE"
```

Export copies the original bytes without generation, conversion, or overwriting an existing file. Choose the extension from `mediaType`. Successful export does not establish display as a conversation attachment; use the current host to read or present the file as requested.

For observation, redelivery, cancellation, or informed retries, read [task continuation and recovery](tasks.md) instead of using another generation command as recovery.
