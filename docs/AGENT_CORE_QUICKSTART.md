# Agent Quickstart · Core 与 MCP 接入指导

This page provides a copy-paste prompt and behavioral reference for AI Agents setting up or operating **Iris 0.3.1** via the Core workbench and MCP. For DSH plugin or standalone CLI setup, see the [DSH/CLI Agent guide](AGENT_QUICKSTART.md); for manual setup steps, see the [Core quickstart](CORE_QUICKSTART.md).

## Setup prompt · 交给 Agent 的接入指令

Copy this prompt to an Agent helping you install, configure, or connect to Iris:

```text
Help me use Iris (@mokuyoaxis/dsh-iris). First read README and check the actual
installed package or source revision, Node version, and available CLI commands.
Verify exact published version availability before installing; if preparing from
source or a local archive, run directly from it without assuming npm publication.
Do not silently switch versions, upgrade DSH, or migrate existing data roots.

Ask which workflow I want: the Core workbench, an existing Iris MCP connection,
the standalone CLI, or DSH's native plugin. Reuse a running Core if appropriate;
otherwise follow docs/CORE_QUICKSTART.md in an explicitly chosen new private root.
Do not scan my disk for clients, credentials, or other workspaces, and ask before
installing dependencies, changing auth policy, or restarting services.

Let me enter media service credentials directly in the workbench and never print
secrets. Confirm the documented protocol, model IDs, intended uses, and pool policy.
Remember that listing a directory, checking config, or opening a draft is read-only
and does not validate or run media generation.

For MCP, create a named connection scoped strictly to the media groups, tools,
and permissions I choose. Generate the matching client template, merge only its
entry into the target client config, and keep exported credentials private. Both
stdio and HTTP connect to the same running Core—do not start a second writer,
wrap the CLI in a custom MCP server, or bypass MCP permission limits via shell.

If I want the generated connection Skill, install it into the explicit Skills
directory (keep it separate from the CLI iris-core Skill).

Once connected, inspect the actual tools and configured models, then perform only
my requested task. Preserve each write's original request UUID and inspect its
receipt. Accepted is not complete: wait for the active Operation in default serial
mode, inspect the original Run/Task before claiming completion, and read back
the resulting artifact before describing it. If acceptance or execution is interrupted
or reports root-busy, look up the original UUID rather than resubmitting, rotating
keys, or deleting a writer lease.

Read-only connections can still recover original Operations as long as Core keeps
its execution service enabled—report service or permission mismatches to me rather
than escalating grants. Report package/source identity, granted scopes, handshake
state, Run/Task/Operation/artifact IDs, and any unverified paths clearly.
```

## Operating an existing MCP connection · 已连接时的行为准则

Once connected, Agents should operate strictly within the granted tools and catalog rather than assuming capabilities from other Iris setups:

| Goal | Expected Agent action |
|---|---|
| Inspect models or workflows | Read the returned directory; use exact `modelRef` values and declared ComfyUI parameters without guessing |
| Create and run media | Clarify parameters, save the Run once, and explicitly continue it with a stable UUID |
| Handle uncertain or busy responses | Preserve the original request UUID; inspect or look up the existing Operation before deciding next steps |
| Recover with read-only access | Query the existing Core execution service via read tools; do not ask to escalate connection permissions unnecessarily |
| Read outputs | Fetch the actual artifact bytes via MCP; distinguish metadata, raw bytes, and client rendering support |
| Permission or Core unavailable | Report the exact denial or transport error; never initialize a new root or remove a writer lease to bypass it |

For ComfyUI workflows, confirm the workflow, source image, style/LoRA, and exposed parameter schema from the catalog first—see [the ComfyUI reference](../skills/iris-core/references/comfyui.md).

## Verification scope · 验证边界

- **Core, MCP, and Vision/OCR flows**: Verified against real Core persistence, production stdio/HTTP MCP transports, and isolated real-model sessions (including DSH native plugin and Kimi MCP vision/OCR sessions covering image import, execution, and post-restart read-only recovery on a synthetic test image).
- **Diagnostics and fresh-workspace walkthrough**: Post-beta.3 rejection diagnostics and fresh-workspace flows were verified with controlled providers, the DSH SDK, and packed Core/MCP consumers. Live paid-media generation and live ComfyUI GPU inference require separate environment verification.
- **OCR overlap behavior**: In the earlier [four-scene OCR check](OCR_VALIDATION.md), all chunks executed accurately per chunk while overlapping long-image boundaries remained duplicated. Iris 0.3.1 adds conservative deterministic cross-chunk overlap deduplication (`boundary-overlap/v0`, preserving raw per-chunk text in the OCR JSON report and passing controlled unit and Core tests); a live paid-model retest on the original 7-request long-image sample has not yet been re-run. Still treat `complete` as full chunk execution rather than proofread text.
