---
name: iris-core
description: "Create, edit, and retrieve persistent Iris images through the standalone CLI without a running DSH host. Use for local image imports, revisions, existing task inspection, and artifact export."
---

# Iris Core · 核心图片工作流

Organize the work around the image the user wants to receive. Reuse existing assets and tasks, preserve originals, and report actual results. Use this skill for a single image operation or a sequence of image revisions and delivery steps.

## Choose the execution path · 确认执行入口

Use the [standalone CLI reference](references/cli.md) to confirm the installed command, explicit data root, and private provider configuration needed for generation. Reuse information already established in the conversation. Do not scan another application's configuration or assume a personal directory, provider, or model.

A visible skill does not prove that its execution tools are available. Report a missing command, connection, or capability precisely. This edition binds to the existing CLI; future MCP and independent workbench integrations need their own verified invocation instructions.

## Plan the image work · 按作品组织步骤

- Import a local image when it needs to become a persistent source. Reuse an existing Artifact in the current root without importing it again.
- Generate for a new image request. For a revision, pass the source Artifact and requested changes to create a related version while retaining the original. Retrieve existing results instead of regenerating them.
- Omit the model override unless the user specifies one, allowing the configured capability policy to select candidates. An explicit model must be allowed for that capability. Names, catalog entries, and past success do not establish present availability.
- Add only steps needed for the requested result. An explicit edit can proceed directly; a generation request does not require extra paid vision checks or another generation.
- Wait for actual delivery before starting a dependent operation. When content verification is required, use an image-reading capability available in the current host. Metadata and file existence alone do not establish visual correctness.

## Preserve asset identities · 保持作品与任务身份

An Artifact ID identifies a persistent asset in a particular Core root; a Task ID identifies an actual operation. Host attachment IDs, file paths, and playback URLs have different meanings. Do not interchange them or construct storage paths from IDs.

Keep the returned Task and Artifact IDs at each handoff. Export to a new, explicit path when a consumer needs a file, preserving the original media format. Use the host's actual capabilities to present that file as an attachment.

## Continue from recorded facts · 根据事实继续

Check the Task's `acceptance`, `outcome`, `deliveryState`, and available Artifacts. Exit code 0 alone does not prove that an image was delivered. Inspect an existing task first; read [task continuation and recovery](references/tasks.md) when waiting, redelivery, cancellation, or an informed retry is needed.

Preserve the original Task after interruption or unknown acceptance; do not probe by submitting another generation. If no Task ID was returned, list tasks read-only in the original root and identify the relevant record. Report uncertainty when that association cannot be established. A busy root does not authorize deleting a lease, taking over a writer, or hiding the original task in a new root.

## Deliver the result · 交付实际结果

Return the actual image file or a host-accessible asset, with the Task/Artifact IDs needed to continue. Distinguish availability, export, display in the conversation, and visual verification. Report partial results and unmet conditions accurately.

This edition covers images and their tasks. It does not imply support for video, speech, UI operations, or a production MCP service in this entry point. Existing DSH skills continue to guide DSH-native tools and workbench workflows.
