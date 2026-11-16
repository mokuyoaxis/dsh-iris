# Agent Quickstart · Core 与 MCP 接入指导

For **0.3.0 Core Web/MCP**, use the [Core quickstart](CORE_QUICKSTART.md). The historical **0.2.7 package has CLI/DSH support without this Web/MCP entry**; [the DSH/CLI Agent guide](AGENT_QUICKSTART.md) covers those paths. Check exact-version availability before installation; during release preparation use source or the local candidate. See the [upgrade guide](UPGRADING_0.3.md). [Vision/OCR](VISION_FLOWS.md) requires a new v5 root and explicit capability and operation grants.

0.3.0 includes the rejection diagnostics and recovery guidance added after beta.3. The execution and permission rules below also apply when an older installed beta shows only a generic rejection message.

Give this instruction to an Agent helping with setup:

```text
Help me use Iris (@mokuyoaxis/dsh-iris). First read README and check the actual
installed package or source revision, Node version and available CLI commands.
Distinguish historical 0.2.7 from the 0.3.0 Core workbench/MCP implementation.
Use an exact published version; a source version does not prove npm publication.
Do not install a different package, upgrade the host or migrate a data root silently.

Ask which path I want: the Core workbench, an existing Iris MCP connection,
direct CLI, or DSH's native plugin. If a suitable Core already runs, reuse it.
Otherwise follow docs/CORE_QUICKSTART.md in an explicitly chosen new private root.
Never scan my disk for clients, credentials or other workspaces. Ask before a new
dependency installation, changing authentication policy or restarting my services.

Let me enter my media service credentials in the workbench. Never print secrets.
Confirm the documented protocol, actual model IDs, intended uses and pool policy.
A directory response, configured capability or successful handshake is not a
successful media test. Opening a draft must not trigger generation.

For MCP, create a named connection only with the media/business, operation scopes
and tools I choose. Generate the matching client template in Iris. Merge just its
entry into the explicitly chosen client config; preserve other entries and keep
the exported credential private. Both stdio and HTTP require the same Core to run.
Do not start another writer, wrap Iris CLI in a fake MCP server, or use CLI/Shell
to bypass an MCP connection's permissions.

Optionally install the generated connection Skill in the client's explicit Skills
directory. It describes only effective MCP tools; the CLI iris-core Skill is for
direct CLI use. Installing a Skill does not establish a connection or grant access.

After connection, discover the actual tools and configured models. Carry out only
my requested media task. Keep each write's original request UUID and inspect its
receipt. Accepted is not complete; an interrupted/unknown request must not be
replaced by another generation. Read back the actual artifact before describing
it, and say explicitly if this client cannot display its content.

In default serial mode, wait for the active Operation to finish before submitting
another operation. Inspect its saved business result, including the original
Run/Task for media flows, before claiming completion or starting a dependent step.
A busy rejection is not a queued
receipt. After busy or uncertain responses, look up the original UUID; do not
retry automatically, switch keys or remove a writer lease.

A read-only connection can recover original Operations when Core retains the
service exposing those reads. This connection needs only read and its selected
read tools, not execute. Report a service/selection mismatch to the owner rather
than changing grants or starting another Core to bypass it.

Report package/source identity, selected permissions, actual handshake, Run/Task/
Operation/artifact IDs where available, result state and what was not verified.
Never claim paid-provider or GPU success from a controlled replay or static check.
```

## When MCP is already connected · 已连接时

The client does not need the owner's password or provider keys. Use the actual connection tools and catalog; do not add tools because a different Iris installation exposes them.

| Intent | Action |
|---|---|
| Inspect configured choices | Read the returned model/workflow directory; preserve exact references and declared parameters |
| Create media | Confirm the requested content and required parameters, then create once and explicitly execute the returned Run |
| Resume an uncertain request | Look up its original request UUID or Operation; report unknown acceptance without resubmitting |
| Core reports a busy writer or lease | Wait for any active Operation, preserve the original UUID/input and inspect the saved state before an explicitly authorized continuation |
| Recover an Operation with read access | Use the existing Core service and selected read tools; keep the Operation service enabled without granting this connection execute |
| Read results | Fetch the original artifact through this connection; distinguish metadata, actual bytes and rendered content |
| Missing permission or business | Explain the actual denial; ask the owner to change the connection if needed, then reconnect |
| Core unavailable | Report transport failure; do not initialize a new root or steal its writer lease |

For ComfyUI, clarify the desired workflow, source image, style/LoRA and exposed parameters first. Read names, defaults and choices from the selected workflow's actual directory. Do not invent a checkpoint, LoRA, graph patch or parameter ID. See [the ComfyUI reference](../skills/iris-core/references/comfyui.md).

## Verification scope · 验证边界

Repository evidence includes real Core persistence, production MCP transports and earlier isolated real-model sessions in Kimi Code and Codex. Published beta.3 was also checked with real DSH native plugin and Kimi MCP model sessions: import an image, save vision/OCR Runs, explicitly execute, then recover the original identities and results after restart through read-only connections. That flow used one clear synthetic image; it does not establish general OCR accuracy or compatibility with every client.

The rejection-diagnostic changes added after beta.3 were checked with controlled providers, the actual DSH SDK and a packed Core/MCP consumer. No paid Agent model session was rerun for those hints, so these checks do not establish that a model will always follow the new guidance. The fresh-workspace walkthrough uses a controlled local media replay; real paid media and a live ComfyUI GPU require separate deployment checks. Start with a read-only task, then explicitly authorize the media operation you actually need.

A separate [four-scene OCR check](OCR_VALIDATION.md) used seven real vision calls through a protocol driver, without another text Agent session. Three authored layouts and one small public photo were scored within predefined bounds. All chunks completed, but overlapping long-image text remained duplicated in the joined output. Treat `complete` as execution coverage, then inspect text accuracy and boundary duplication separately.
