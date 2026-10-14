# Iris UI verification verdict and degradation

Read this reference when preparing the final verdict or when a required verification capability is unavailable.

## Verdict template

Use exactly one verdict:

- **Pass**: all objective requirements are satisfied and comparable evidence supports the conclusion.
- **Partial pass**: the primary goal is satisfied, but localized differences or environmental noise remain.
- **Fail**: comparable evidence confirms a required criterion is unmet. Describe the failed criterion; do not replace a known failure with uncertainty.
- **Indeterminate**: a reference is missing, capture conditions differ, a required tool is unavailable, or evidence is insufficient.

A reference screenshot is needed for reference-matching claims; explicit acceptance criteria can still support a verdict without one. Use Partial pass only for remaining optional/minor items when the required goal passes. A required criterion that fails takes precedence over missing evidence for other criteria; report those uncertainties alongside Fail.

Report:

1. Conditions: inputs, dimensions, theme, capture method, and known noise.
2. Changes: what changed and why, if edits were authorized.
3. Evidence: before/after diff, worst regions, bounding boxes, and attachments.
4. Verdict: one value from the list above.
5. Remaining work: human judgment or real-browser checks still needed.

For “pixel-identical,” require matching dimensions and render conditions. A normalized diff whose longest side was reduced to 1024 pixels cannot prove original-resolution identity.

## Safe degradation

- Browser unavailable: request a current screenshot and continue with supplied images.
- Vision unavailable: skip semantic inspection and model location; use known coordinates, crops, and pixel diff.
- `iris_locate` unstable: narrow the target from the heatmap and known layout; do not retry blindly or invent coordinates.
- HTML needs scripts or remote resources: use an offline-renderable static version or the project’s existing real-browser capture workflow.
- Dynamic reference data cannot be frozen: isolate or report it as noise; otherwise use **Indeterminate**.

Never finish with only “looks correct,” and never report precision unsupported by the available evidence.
