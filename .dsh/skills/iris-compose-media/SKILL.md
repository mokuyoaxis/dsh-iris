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

### Analyze an image, then draw

1. Inspect the source with `iris_look_at_image` or `iris_relook_attachment`. Ask specifically about the subject, composition, palette, style, visible text, and the transformation requested by the user.
2. Convert the observations into a self-contained generation prompt. Separate facts visible in the source from requested changes; preserve explicit constraints and exact text.
3. Call `iris_draw_image` once for each requested artifact.
4. If the user requested verification or iteration, inspect the generated attachment with `iris_relook_attachment` against the original requirements. Regenerate only for a concrete mismatch.

### Generate a still, then animate it

1. Create the still with `iris_draw_image`, reuse an Iris-produced first-frame attachment, or obtain a host-visible absolute path for the supplied image. Do not pass an ordinary session attachment as `first_frame_attachment_id`.
2. Write a motion prompt describing camera movement, subject motion, timing, and what must remain stable. Do not merely repeat the still-image prompt.
3. Call `iris_generate_video` with `first_frame_attachment_id` or `first_frame_path` for i2v. Use `size` and `duration` only when appropriate for the selected t2v/i2v model.
4. If the call returns a background task ID, use `iris_task_status` before claiming that the video exists.

### Summarize a video, then narrate it

1. Call `iris_media_summarize` with the user's question and `transcribe=true` unless they want a visual-only summary.
2. Do not also call `iris_video_frames` or `iris_transcribe_audio` by default: `iris_media_summarize` already samples frames and optionally transcribes the audio track.
3. Turn the summary into narration suited to the requested audience and length. Do not present inferred details as visible facts.
4. Call `iris_speak_text` and return the summary, contact-sheet attachment, and saved audio path.

Use `iris_video_frames` separately only when the user explicitly needs individual frames or a custom frame-level workflow. Use `iris_transcribe_audio` separately when the full transcript itself is required or when the input is an audio file rather than a video-summary task.

### Create an S2V talking video

1. Resolve or generate a suitable first-frame portrait.
2. Use an existing host audio file, or call `iris_speak_text` and capture its saved absolute path.
3. Confirm that the audio is a clear human voice in WAV or MP3 format, smaller than 15 MB, and shorter than 20 seconds. Shorten the script and synthesize it again if the generated speech exceeds the limit.
4. Call `iris_generate_video` with an S2V model, `first_frame_attachment_id` or `first_frame_path`, `audio_path`, and `resolution` of `480P` or `720P`. Do not pass t2v/i2v-only `size` or `duration` controls.
5. Track a background result with `iris_task_status`; do not submit a duplicate while it is running.

### Turn recognized content into a new artifact

Use `iris_long_ocr` for image text or `iris_transcribe_audio` for audio speech, then structure the recognized content for the requested output. Feed only the necessary, checked facts into `iris_draw_image`, `iris_speak_text`, or `iris_generate_video`. Preserve names, numbers, and quoted wording exactly when accuracy matters.

## Control cost and iteration

- Make one generation attempt per requested artifact by default.
- A request to create an artifact authorizes that requested generation; do not ask again solely because it may incur provider cost.
- Run at most 2 generation attempts per artifact unless the user explicitly requests a larger iterative loop.
- Review does not automatically authorize regeneration. If the user asked only for one result, report a detected mismatch and offer the next step.
- Do not probe models or create speculative alternatives as part of the workflow.
- Honor an explicit `providerId::modelId` override. Otherwise use the configured capability assignment and its ordered failover list.

Iris generation failover covers upload, submission, and synchronous-generation failures only. Once a remote service accepts an asynchronous task, that task is bound to its provider. If polling, waiting, or download later fails, query `iris_task_status` and report the state; never resubmit automatically, because that can duplicate work and billing.

## Handle tasks, cancellation, and failures

- Continue immediately when a tool returns a completed attachment, text, or local path.
- When a tool reports a background task, wait or query with `iris_task_status` only when the next step depends on its output.
- If the user cancels, stop the chain. Do not launch downstream generation after cancellation, even if an earlier artifact later completes.
- If an attachment cannot be found, ask the user to re-upload it or provide a host path.
- If `ffmpeg` or `ffprobe` is unavailable, video frames and video summarization cannot run. Explain the missing optional dependency; do not claim that visual video analysis completed.
- If vision is unavailable but the user's creation prompt is already complete, skip source analysis and proceed only when that still satisfies the request.
- Preserve partial outputs. Report which step succeeded, which step failed, and whether any accepted task remains active.

## Report the result

Return a compact workflow record containing:

1. the completed chain and any material assumptions;
2. attachment IDs and host paths needed to use the outputs;
3. task IDs and their last known status;
4. any omitted or failed step and its effect on the final artifact;
5. whether further generation would require another attempt.

Never describe a queued or running task as complete. Never hide that a summary omitted audio, that a review was skipped, or that the final artifact differs from the request.
