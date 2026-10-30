# Agent Quickstart · Core 与 MCP 接入指导

For **0.3.0-alpha.1 Core Web/MCP**, use the [Core quickstart](CORE_QUICKSTART.md). Stable npm **0.2.7 has CLI/DSH support, without this Web/MCP entry**; use [the stable Agent guide](AGENT_QUICKSTART.md) for it. Install the exact alpha or explicitly choose the alpha channel.

Give this instruction to an Agent helping with setup:

```text
Help me use Iris (@mokuyoaxis/dsh-iris). First read README and check the actual
installed package or source revision, Node version and available CLI commands.
Distinguish stable 0.2.7 from the 0.3.0-alpha.1 Core workbench/MCP implementation.
Installing latest does not opt into alpha; use the exact prerelease or alpha tag.
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
| Read results | Fetch the original artifact through this connection; distinguish metadata, actual bytes and rendered content |
| Missing permission or business | Explain the actual denial; ask the owner to change the connection if needed, then reconnect |
| Core unavailable | Report transport failure; do not initialize a new root or steal its writer lease |

For ComfyUI, clarify the desired workflow, source image, style/LoRA and exposed parameters first. Read names, defaults and choices from the selected workflow's actual directory. Do not invent a checkpoint, LoRA, graph patch or parameter ID. See [the ComfyUI reference](../skills/iris-core/references/comfyui.md).

## Verification scope · 验证边界

Repository evidence includes real Core persistence, production MCP transports and isolated real-model sessions in Kimi Code and Codex. These are specific tested clients and versions, not a guarantee for every client. The fresh-workspace walkthrough uses a controlled local media replay; real paid media and a live ComfyUI GPU require separate deployment checks. Start with a read-only task, then explicitly authorize the media operation you actually need.
