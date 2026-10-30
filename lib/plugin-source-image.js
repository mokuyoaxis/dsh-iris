// Shared source-image limits for the catalog and the plugin command boundary.
const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
export function isPluginSourceImage(artifact) {
  return MEDIA_TYPES.has(artifact.mediaType) && artifact.size <= 8 * 1024 * 1024;
}
