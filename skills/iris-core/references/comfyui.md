# ComfyUI workflows · 工作流、参数与 API 搭配

This reference describes the **unreleased 0.3-target implementation**, not npm 0.2.7. Confirm the installed command and returned catalog before using it; missing support does not authorize installing or upgrading software. Keep the explicit roots and private provider file from the [CLI reference](cli.md).

## Ask before creating · 提问确认需求

ComfyUI selects an executable workflow with its own exposed controls. Before creating or executing a request, establish:

- The desired subject, style, changes and output. Ask whether a source image must be preserved when the request suggests editing.
- The configured workflow to use, or whether the user prefers API generation or wants a recommendation from the available workflows.
- Any required LoRA and separate model/CLIP weights; size, seed or reproducibility requirements. Offer to keep the workflow defaults for unspecified settings; do not require the user to understand every sampler control.

Ask only for missing information, preferably in one compact question. For example: “What should the image contain and look like? Which of these configured workflows should I use? Do you need a particular LoRA, size or seed, or should I keep that workflow's defaults?” Use the user's language and real catalog choices. If the user delegates selection, choose a suitable actual workflow and state the choice and assumptions. Reuse established answers and authorization; do not ask again before each already authorized stage.

Read-only directory inspection may precede the question. While essential choices remain unanswered, do not generate a sample, create a trial Run/Task, change a provider, or install a workflow/model. A missing workflow is a configuration gap to explain, not permission to fabricate a template or silently substitute an API model.

## Read the actual directory · 使用真实目录

```bash
dsh-iris models list --provider-config "$IRIS_PROVIDER_FILE"
```

Choose the returned model `ref`. A `comfyWorkflow` summary identifies the configured template; read its `parameters` for actual IDs, labels, types, defaults, ranges and declared choices. Use `imageRouting` and edit support to distinguish API models from workflows, rather than guessing from names such as SDXL or Flux. A configured entry is not proof that the service, nodes or GPU are usable.

LoRA names belong to **existing workflow slots**. Read current available choices through an explicit read-only workflow check when needed and authorized. The check queries node definitions without generating or changing configuration; it cannot establish real inference success. If options are truncated, do not claim an unseen name was verified. Ask for the intended installed name or retain the confirmed default.

Only override declared parameter IDs and supported scalar values. Keep model and CLIP weights separate, including zero/negative values when allowed; do not set them equal without the user's intent. Multiple LoRAs require existing slots in the workflow. A fixed v0 template exposes no runtime parameters. Do not invent a node, a LoRA filename, an arbitrary graph patch or an undeclared negative-prompt field. Integer seeds must fit the JavaScript safe range; keep sampler defaults unless a change is requested or delegated.

## Execute the selected path · 执行明确入口

For CLI image generation, write the approved input to a new private JSON file: actual `model_ref`, `prompt`, `n:1`, optional supported `size`, and optional `workflow_parameters` containing only requested overrides. Omit an empty parameter map. Omit size when the workflow has no size binding. Then use the existing image entry:

```bash
dsh-iris run image --data-root "$IRIS_DATA_ROOT" --provider-config "$IRIS_PROVIDER_FILE" --input-file "$IRIS_INPUT_FILE"
```

An optional static check uses a **separate** input file containing just `workflow_parameters` with the same approved overrides; omit `--input` if there are none:

```bash
dsh-iris models workflow-check "$IRIS_MODEL_REF" --provider-config "$IRIS_PROVIDER_FILE" --input "$(cat "$IRIS_CHECK_FILE")"
```

The file contains data, not executable shell text. Never substitute prompt text directly into shell code. Read the check's `ok`, issues and limits; exit code 0 alone is not a passing inspection. Checking and generating are separate actions.

For persistent Flow creation, the input also uses `model_ref` and `workflow_parameters`. Text-to-image requires an explicitly initialized new v2 execution root; do not migrate an existing root. Create once, keep the returned Run, and explicitly continue it. A Flow retains private request input, while a standalone Task does not retain the prompt. Follow the invocation supported by the installed version rather than switching formats mid-task.

For an authorized MCP connection, follow its generated skill and actual tool schemas: the directory returns `modelRef`, creation uses `workflowParameters`, and creation saves a Run without generating. A missing directory or execution tool is a capability gap; do not call an unavailable tool or switch to shell commands to bypass it. Owner workflow checks are not automatically available through media MCP tools.

## Combine API and ComfyUI · 选择与串联

| User goal | Supported approach |
|---|---|
| A quick API image | Use the configured API policy or an explicit allowed API model; skip the ComfyUI questionnaire unless the request needs it |
| An existing workflow, LoRA or controlled seed | Confirm the actual ComfyUI workflow and exposed parameters before generation |
| ComfyUI base image, followed by API revision | Generate once, wait for the original Artifact, then pass that same-root Artifact to an explicitly chosen API model that supports editing |
| API image refined by ComfyUI | Explain that the current Iris ComfyUI adapter has no source-image upload/binding; do not claim a reverse image-edit chain works |
| Compare API and ComfyUI | Only when requested, plan two independent generations and their additional work/cost; keep distinct task identities, then show actual results |

For the supported ComfyUI → API chain, use the existing image-edit input: `source_artifact_id` for CLI or `sourceArtifactId` for MCP. Do not carry `workflow_parameters`/`workflowParameters` into the API edit. Both stages need their actual permissions and user intent; authorization for the whole stated chain need not be requested again per step. Keep the original image and the second stage's lineage. If stage two fails, recover stage two instead of regenerating stage one.

Do not silently switch backends as recovery. An API substitute may lose LoRA, workflow or seed semantics. If a substitute is already authorized, establish the original request's acceptance and what tradeoffs that authorization covers; unknown acceptance still requires preserving the original task and any possible duplicate work/billing. Never rebind an old Task/Run to a different model or new template.

## Recover original facts · 恢复原任务

- Standalone CLI: inspect the returned Task in its original root, then use [task recovery](tasks.md) to observe, wait or redeliver that same Task. Preserve it when acceptance is unknown; do not test by submitting again.
- Persistent Flow/MCP: retain Run/Operation/Task/Artifact IDs, current Run revision and original request UUIDs. Read the original records after interruption. An Operation completing does not prove the remote image completed; explicitly continue the original Run only when authorized and supported by its state. Do not apply standalone Task retry to work around a Flow binding.
- A lost creation reply does not justify a new key. Recover the original creation identity when the selected entry supports it; otherwise read the original records and report any remaining uncertainty before further work.
- Query the original remote job rather than rechecking node catalogs as a substitute for task observation. A changed template can block old-task rebinding; preserve the old record and explain the mismatch.
- Stopping local waiting is not confirmed remote cancellation. The current ComfyUI adapter does not send `/interrupt`. Retrieve and present the actual delivered image; visual quality requires viewing it, not just reading metadata.
