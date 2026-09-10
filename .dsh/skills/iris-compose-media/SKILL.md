---
name: iris-compose-media
description: "Compose two or more dsh-iris tools into goal-driven image, video, speech, transcription, and multimodal workflows. Use when a request requires analyzing supplied media and creating a derivative, generating then reviewing an image, turning a video summary into narration, preparing image and audio inputs for video, or coordinating asynchronous Iris tasks. Do not use for a single direct media operation. 用于看图后绘图、生成后自检、视频总结配旁白、图像加语音生成视频等多步骤媒体任务。"
---

# Compose Media with Iris

Turn a media goal into the shortest reliable chain of Iris tools. Preserve useful attachments and paths between steps, keep paid generation bounded, and distinguish an accepted background task from a finished artifact.

## Decide whether to use this skill

Use this skill only when the request needs two or more dependent Iris operations. Typical triggers include:

- analyze an image, then create a new image from the findings;
- generate an image, inspect it, and revise only if requested;
- summarize a video, then write and synthesize narration;
- generate or reuse a still image, synthesize speech, then create an S2V video;
- transcribe or OCR source media, then turn its content into another artifact.

For one direct operation such as drawing, describing, OCR, transcription, speech synthesis, or video generation, do not use this skill; call the matching tool directly. For screenshot comparison or frontend visual acceptance, use `iris-verify-ui` instead.

Ask one concise question only when a missing source, target format, voice, aspect ratio, or intended audience would materially change the result. Otherwise make a conservative assumption and state it in the result.

## Plan the chain

Before calling tools, identify:

1. the source media and how Iris can read it;
2. the requested final artifact;
3. the minimum dependent tool chain;
4. which steps can incur generation cost;
5. whether a downstream step needs a file path, attachment ID, text, or completed task.

Do not add an analysis, transcription, or review step merely because a tool exists. Parallelize only independent read-only work; dependent media operations must remain ordered.

## Resolve media inputs

- Use `iris_look_at_image` for an absolute image path visible to the host.
- Use `iris_relook_attachment` for an image attachment already present in the session or produced by Iris.
- Use `iris_long_ocr` when exact text from an image matters more than a visual description.
- Video and audio tools require host-visible absolute `video_path` or `audio_path` values. A browser-local path, `content://` URI, or ordinary web URL is not a host path; request an upload or exported host path.
- Keep every returned attachment ID, task ID, and output path that a later step needs. Do not invent or reconstruct identifiers.

An attachment returned by `iris_draw_image` can be passed as `first_frame_attachment_id` to `iris_generate_video`. An existing host image uses `first_frame_path`. The local path returned by `iris_speak_text` can be passed as `audio_path` for S2V.

## Choose a workflow

Choose the minimum chain, then read only the matching section of [references/workflows.md](references/workflows.md):

- inspect an image, then draw: `iris_look_at_image` or `iris_relook_attachment` → `iris_draw_image`;
- generate/reuse a still, then animate: optional `iris_draw_image` → `iris_generate_video`;
- summarize a video, then narrate: `iris_media_summarize` → `iris_speak_text`;
- create an S2V talking video: resolve a first frame and audio → `iris_generate_video`;
- recognize, then create: `iris_long_ocr` or `iris_transcribe_audio` → the requested creation tool.

Use `iris_video_frames` only for explicit frame extraction or a custom frame-level workflow. Do not load every workflow section when one route is sufficient.

## Control cost and iteration

- Create one new Iris generation **Task** per requested artifact by default. A Provider Attempt is an internal candidate submission inside that Task; do not count failover attempts as user-authorized new Tasks.
- The original request authorizes its requested artifact. Review alone does not authorize regeneration.
- Create at most 2 new generation Tasks per artifact, and only when the first Task has a known terminal outcome and the user explicitly requested iteration. Respect a lower or higher bound stated by the user.
- Do not probe models or create speculative alternatives. Honor an explicit `providerId::modelId`; otherwise use Iris capability assignment and bounded failover.
- Automatic failover is allowed only while the current Provider Attempt has `acceptance=not_accepted`. Accepted, acceptance-unknown, or outcome-unknown work must never trigger another Provider Attempt or Task automatically.

## Handle Task v2, cancellation, and failures

When a generation tool returns a Task, or the user asks to retry, recover, cancel, or deliver one, read [references/task-v2-recovery.md](references/task-v2-recovery.md). Its stop rules are mandatory.

- Continue immediately only from a completed attachment, text, or local path.
- Use `iris_task_status` to observe an existing background Task when a dependent next step needs the result. Never describe queued/running work as complete.
- Observation failure resumes observation; delivery failure resumes delivery. Neither authorizes regeneration. If that recovery action is available only in the Iris workbench, say so and preserve the Task ID.
- If the user cancels, stop the chain and do not launch downstream generation. Cancellation requested or unknown is not proof that no provider work occurred.
- Preserve partial outputs. Report which step succeeded, which failed or became uncertain, and whether accepted work may remain active.
- If an attachment is missing, request a re-upload or host path. If `ffmpeg`/`ffprobe` is unavailable, explain that frame extraction and video summarization cannot run.
- If vision is unavailable but the creation prompt is complete, skip source analysis only when the requested result still remains valid.

## Report the result

Return a compact workflow record containing:

1. the completed chain and any material assumptions;
2. attachment IDs and host paths needed to use the outputs;
3. task IDs and their last known status;
4. any omitted or failed step and its effect on the final artifact;
5. whether further generation would create another potentially billable Task.

Never hide that a summary omitted audio, that a review was skipped, or that the final artifact differs from the request.
