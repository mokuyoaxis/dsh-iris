# Iris composition workflow details

Read only the section matching the chosen workflow. Keep paid steps bounded by the main Skill and Task v2 recovery rules.

## Inspect, then draw

1. Inspect the source with `iris_look_at_image` or `iris_relook_attachment`. Ask about subject, composition, palette, style, visible text, and the requested transformation.
2. Turn observations into a self-contained prompt. Separate visible facts from requested changes and preserve exact text.
3. Call `iris_draw_image` once for each requested artifact.
4. Inspect the result only when verification or iteration was requested. A mismatch is evidence to report, not automatic permission to regenerate.

## Generate or reuse a still, then animate

1. Create a still with `iris_draw_image`, reuse an Iris-produced first-frame attachment, or obtain a host-visible path. Do not pass an ordinary session attachment as `first_frame_attachment_id`.
2. Write a motion prompt that covers camera movement, subject motion, timing, and invariants.
3. Call `iris_generate_video` with `first_frame_attachment_id` or `first_frame_path`. Use only controls supported by the selected t2v/i2v model.
4. Observe a returned Task before claiming that the video exists.

## Summarize a video, then narrate

1. Call `iris_media_summarize` with `transcribe=true` unless the user wants visual-only analysis.
2. Do not also call `iris_video_frames` or `iris_transcribe_audio` by default; the summary action already samples frames and can transcribe audio.
3. Write narration for the requested audience and length without presenting inference as visible fact.
4. Call `iris_speak_text`; return the summary, contact-sheet attachment, and saved audio path.

Use `iris_video_frames` separately only for individual frames or a custom frame workflow. Use `iris_transcribe_audio` separately for a full transcript or an audio-only input.

## Create an S2V talking video

1. Resolve or generate a suitable first-frame portrait.
2. Use existing host audio or call `iris_speak_text` and keep its absolute output path.
3. Confirm that the audio is a clear human voice in WAV/MP3, smaller than 15 MB, and shorter than 20 seconds.
4. Call `iris_generate_video` with an S2V model, first-frame input, `audio_path`, and `480P` or `720P`. Do not pass t2v/i2v-only `size` or `duration` controls.
5. Observe the returned Task; do not submit a duplicate while it is running.

## Turn recognized content into a new artifact

Use `iris_long_ocr` for exact image text or `iris_transcribe_audio` for speech, then pass only necessary checked facts into the selected generation tool. Preserve names, numbers, and quoted wording when accuracy matters.
