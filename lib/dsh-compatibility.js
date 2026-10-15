'use strict';

/** 已完成宿主接口验收的版本；manifest/Doctor/验收脚本共用同一边界。 */
export const SUPPORTED_DSH_VERSIONS = Object.freeze(['0.2.0-rc.2', '0.2.1-alpha.4']);
export const DSH_SUPPORT_RANGE = SUPPORTED_DSH_VERSIONS.join(' || ');

export function isSupportedDshVersion(value) {
  const version = String(value || '').trim().split('+')[0];
  return SUPPORTED_DSH_VERSIONS.includes(version);
}
