---
name: iris-verify-ui
description: "Verify web UIs, HTML, and interface screenshots with dsh-iris through repeatable capture, semantic inspection, element location, cropping, pixel-diff analysis, and bounded rechecks. Use when comparing a UI with a reference image, locating visual regressions, validating frontend changes, or matching an implementation to a design. 用于对照参考图检查界面、定位视觉偏差、验证前端修改或比较两张 UI 截图。"
---

# Verify UI with Iris

Use vision models to understand and locate problems. Use deterministic pixel tools to measure them. Establish comparable capture conditions before editing, then recheck under the same conditions. Do not declare success from visual impression alone.

## Choose the shortest path

Select a path from the evidence provided:

- Current and reference screenshots are both available: compare them directly; do not recapture.
- Raw HTML and a reference screenshot are available: capture the current version with `iris_html_screenshot`.
- Editable page source is available but no current screenshot exists: use the project's browser or screenshot workflow first. `iris_html_screenshot` accepts an HTML string; it cannot navigate an arbitrary URL.
- Only one screenshot is available and no reference or acceptance criteria exist: perform a semantic review and state that comparative pixel verification is not possible.
- The request is only to describe, OCR, or generate media: do not use this skill. Use the matching Iris tool or a media-composition skill.

Ask one concise question only when a missing reference, target state, theme, or viewport would materially change the result. Make conservative assumptions otherwise and record them in the verdict.

## Prepare the inputs

1. Identify each image source:
   - Host absolute path: pass `image_path`.
   - Current-session or Iris-produced attachment: pass `attachment_id`.
   - Browser-local path, `content://` URI, or ordinary web URL: do not assume the host can read it. Ask for an upload or a host-accessible file.
2. Record the comparison conditions: viewport, screenshot dimensions, device pixel ratio, theme, fonts, zoom, scroll position, and dynamic-content state.
3. Freeze time, animation, cursor, random content, loading state, and scrollbars where practical.
4. Require matching image dimensions for reliable UI comparison. If dimensions differ, recapture before comparing; do not let automatic stretching hide a layout error.

## Run the verification loop

### 1. Establish the baseline

State the current image, reference image, target area, and acceptance criteria. Follow a threshold supplied by the user. If no threshold exists, do not invent a universal passing percentage.

When raw HTML needs capture, call `iris_html_screenshot` with the same HTML wrapper, `fullPage` value, and size parameters for every iteration. Account for these constraints:

- `width` and `height` set a minimum container size; they do not control the browser viewport.
- The page runs in an opaque-origin CSP sandbox. Scripts, external network access, form submission, and remote resources are unavailable.
- Inline required styles, fonts, and images, or use data URLs.
- The shared browser may briefly show the temporary tab.
- `iris_html_screenshot` is not concurrency-safe. Capture multiple states sequentially.

### 2. Inspect semantics

Inspect the current and reference images separately. Call `iris_look_at_image` for a host path and `iris_relook_attachment` for an attachment.

Each vision call sees only one image. Ask the same structured questions for both images:

- List visible components, relative positions, and hierarchy by top, middle, and bottom regions.
- Identify clipping, overflow, misalignment, unusual spacing, typography, and color issues.
- Record the target element's position relative to its container and neighboring elements.

Compare the two observation sets and prioritize the differences. Treat vision answers as diagnostic leads, not pixel evidence.

### 3. Measure the whole image

Call `iris_pixel_diff` with the current and reference images. Record:

- diff ratio
- changed-pixel count and normalized dimensions
- worst grid regions
- heatmap attachment ID

Use the result as UI regression evidence only when image dimensions and render conditions match. The tool ignores alpha and counts RGB differences above its noise threshold. It stretches mismatched images to the smaller dimensions and downsizes when the longest side exceeds 1024 pixels. A low normalized diff therefore does not prove that the original large images are pixel-identical.

### 4. Locate and verify local regions

When a component must be located, call `iris_locate` separately on the current and reference images:

- Compare the two bounding boxes to detect position and size changes.
- If it returns `found=false`, retry once with a more specific target. If it still fails, report uncertain location; never fabricate coordinates.
- Treat the model-generated bounding box as a hypothesis and cross-check it against the screenshots and heatmap.

Use `iris_crop` when local evidence is needed:

- For a same-coordinate comparison, use identical `left`, `top`, `width`, and `height` on both images.
- When an element moved, report bounding-box geometry first. Do not crop different shapes and then use a stretched diff to hide the movement.
- Keep any added margin within image boundaries.

Run `iris_pixel_diff` on the two crop attachments to verify whether the problem is concentrated in the expected component.

### 5. Modify and recheck

Edit source files only when the task authorizes changes. Fix the highest-impact deterministic issue first, keep the patch focused, and preserve existing user changes.

After each modification:

1. Capture again under the baseline conditions.
2. Rerun the whole-image diff.
3. Recheck the previous worst regions.
4. Record before-and-after diff ratios and bounding-box changes.
5. Confirm that the fix did not move the difference elsewhere.

Run at most 3 modify-and-recheck rounds by default. Stop as soon as the user's criteria pass. Also stop when one round gives no improvement, capture conditions cannot be aligned, or remaining differences come from the environment. Explain the stopping reason instead of looping indefinitely.

## Assign a verdict

Use exactly one verdict:

- **Pass**: all objective requirements are satisfied and the evidence supports the conclusion.
- **Partial pass**: the primary goal is satisfied, but localized differences or environment noise remain.
- **Indeterminate**: a reference is missing, capture conditions differ, a required tool is unavailable, or evidence is insufficient.

For a “pixel-identical” claim, require matching dimensions and matching render conditions. When the longest side exceeds 1024 pixels, `iris_pixel_diff` downsizes the comparison and cannot by itself prove original-resolution identity.

## Degrade safely

- `dsh-builtin-browser` unavailable: ask for a current screenshot and continue with image comparison.
- Vision model unavailable: skip semantic inspection and model location; continue with known coordinates, crops, and pixel diff.
- `iris_locate` unstable: narrow the target using the heatmap and known layout; do not retry blindly.
- HTML depends on scripts or remote resources: create a static offline-renderable version, or use the project's existing screenshot workflow.
- Reference contains dynamic data: freeze or mask dynamic regions. If that is impossible, report them separately as noise.

## Report the result

Include:

1. Conditions: inputs, dimensions, theme, capture method, and known noise sources.
2. Changes: what changed and why.
3. Evidence: before-and-after diff, worst regions, key bounding boxes, and relevant attachments.
4. Verdict: Pass, Partial pass, or Indeterminate.
5. Remaining work: anything requiring human judgment or a real-browser check.

Do not finish with only “looks correct.” Do not report precision that the evidence cannot support.
