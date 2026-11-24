// Shared source-artifact limits for the catalog and the plugin command boundary.
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const AUDIO_MEDIA_TYPES = new Set(['audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/flac']);
const VIDEO_MEDIA_TYPES = new Set(['video/mp4', 'video/webm']);

export const PLUGIN_ARTIFACT_KINDS = Object.freeze({
  image: 'plugin-image',
  audio: 'plugin-audio',
  video: 'plugin-video',
  text: 'plugin-text',
  json: 'plugin-json'
});
export const ALL_PLUGIN_ARTIFACT_KINDS = Object.freeze(new Set(Object.values(PLUGIN_ARTIFACT_KINDS)));
export const PLUGIN_MEDIA_LIMITS = Object.freeze({
  image: 20 * 1024 * 1024,
  audio: 20 * 1024 * 1024,
  video: 32 * 1024 * 1024,
  text: 1024 * 1024,
  json: 1024 * 1024
});

/** Legacy 8 MiB static-image gate retained for operations without explicit artifactInputTypes. */
export function isPluginSourceImage(artifact) {
  return IMAGE_MEDIA_TYPES.has(artifact?.mediaType) && artifact.size > 0 && artifact.size <= 8 * 1024 * 1024;
}

export function pluginArtifactMediaKind(artifactOrType) {
  const mediaType = typeof artifactOrType === 'string' ? artifactOrType : artifactOrType?.mediaType;
  if (IMAGE_MEDIA_TYPES.has(mediaType)) return 'image';
  if (AUDIO_MEDIA_TYPES.has(mediaType)) return 'audio';
  if (VIDEO_MEDIA_TYPES.has(mediaType)) return 'video';
  if (mediaType === 'text/plain') return 'text';
  if (mediaType === 'application/json') return 'json';
  return null;
}

export function isPluginSourceArtifact(artifact, allowedKinds = null) {
  if (!allowedKinds) return isPluginSourceImage(artifact);
  const kind = pluginArtifactMediaKind(artifact);
  return kind !== null && allowedKinds.includes(kind) && artifact.size > 0 && artifact.size <= PLUGIN_MEDIA_LIMITS[kind];
}

export function pluginOperationAllowedInputKinds(descriptor) {
  if (!descriptor?.artifactInputs?.length) return [];
  if (!descriptor.artifactInputTypes) return null;
  const kinds = new Set();
  for (const field of descriptor.artifactInputs) {
    for (const kind of descriptor.artifactInputTypes[field] || ['image']) kinds.add(kind);
  }
  return [...kinds];
}

export function pluginArtifactInputKindsForId(descriptor, input, artifactId) {
  if (!descriptor?.artifactInputTypes) return null;
  const kinds = new Set();
  for (const field of descriptor.artifactInputs || []) {
    const value = input?.[field];
    const matched = Array.isArray(value) ? value.includes(artifactId) : value === artifactId;
    if (!matched) continue;
    for (const kind of descriptor.artifactInputTypes[field] || ['image']) kinds.add(kind);
  }
  return kinds.size ? [...kinds] : [];
}
