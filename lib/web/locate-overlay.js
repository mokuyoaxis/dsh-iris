// Pure SVG bbox overlay math and CSP-safe DOM rendering (zero inline styles).
const SVG_NS = 'http://www.w3.org/2000/svg';

function finiteInt(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

/** Clamp a pixel crop rectangle strictly inside [0..imageWidth, 0..imageHeight]. */
export function clampCropRect(rect, imageWidth, imageHeight) {
  if (!Number.isSafeInteger(imageWidth) || imageWidth < 1 || !Number.isSafeInteger(imageHeight) || imageHeight < 1) {
    throw new TypeError('图片尺寸无效');
  }
  const left = Math.max(0, Math.min(imageWidth - 1, finiteInt(rect?.left, 0)));
  const top = Math.max(0, Math.min(imageHeight - 1, finiteInt(rect?.top, 0)));
  const width = Math.max(1, Math.min(imageWidth - left, finiteInt(rect?.width, 1)));
  const height = Math.max(1, Math.min(imageHeight - top, finiteInt(rect?.height, 1)));
  return { left, top, width, height };
}

export function isSameCropRect(a, b) {
  return Boolean(a && b) && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;
}

// Core stores raw pixel coordinates. The browser displays the EXIF-oriented image.
function displayRect(rect, imageWidth, imageHeight, orientation) {
  const { left, top, width, height } = rect;
  const rightMargin = imageWidth - left - width;
  const bottomMargin = imageHeight - top - height;
  switch (orientation) {
    case 2: return { left: rightMargin, top, width, height };
    case 3: return { left: rightMargin, top: bottomMargin, width, height };
    case 4: return { left, top: bottomMargin, width, height };
    case 5: return { left: top, top: left, width: height, height: width };
    case 6: return { left: bottomMargin, top: left, width: height, height: width };
    case 7: return { left: bottomMargin, top: rightMargin, width: height, height: width };
    case 8: return { left: top, top: rightMargin, width: height, height: width };
    default: return rect;
  }
}

/**
 * Compute an exact SVG overlay descriptor whose viewBox matches the natural image dimensions.
 * CSS `object-fit: contain` (50% 50%) and SVG `preserveAspectRatio="xMidYMid meet"` solve the
 * identical letterbox transform, keeping pixel coordinates aligned across every viewport size.
 */
export function buildLocateOverlaySpec({ imageWidth, imageHeight, result, cropRect = null, showBox = true, showScrim = true } = {}) {
  if (!Number.isSafeInteger(imageWidth) || imageWidth < 1 || !Number.isSafeInteger(imageHeight) || imageHeight < 1) {
    return { visible: false, reason: 'no_image' };
  }
  if (!result || result.found !== true || !result.bbox) {
    return { visible: false, reason: 'not_found' };
  }
  const { width: rawWidth, height: rawHeight } = result;
  const orientation = result.input?.orientation;
  const swapsDimensions = [5, 6, 7, 8].includes(orientation);
  if ((swapsDimensions ? rawHeight : rawWidth) !== imageWidth || (swapsDimensions ? rawWidth : rawHeight) !== imageHeight) {
    return { visible: false, reason: 'dimension_mismatch' };
  }
  const rawBox = clampCropRect(result.bbox, rawWidth, rawHeight);
  const adjusted = cropRect ? clampCropRect(cropRect, rawWidth, rawHeight) : null;
  const bbox = displayRect(rawBox, rawWidth, rawHeight, orientation);
  const customCrop = adjusted && !isSameCropRect(adjusted, rawBox)
    ? displayRect(adjusted, rawWidth, rawHeight, orientation) : null;
  const activeRect = customCrop || bbox;
  return {
    visible: Boolean(showBox),
    reason: 'ok',
    viewBox: `0 0 ${imageWidth} ${imageHeight}`,
    imageWidth,
    imageHeight,
    bbox,
    customCrop,
    scrimRect: showBox && showScrim ? activeRect : null
  };
}

function svgNode(doc, tag, attrs = {}) {
  const node = doc.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

/** Render a LocateOverlaySpec into an <svg> element without innerHTML or inline styles. */
export function renderLocateSvg(svgElement, spec, { maskId = 'locate-scrim-mask' } = {}) {
  if (!svgElement) return;
  if (!spec || !spec.visible || spec.reason !== 'ok') {
    svgElement.setAttribute('hidden', '');
    svgElement.hidden = true;
    svgElement.replaceChildren();
    svgElement.removeAttribute('viewBox');
    return;
  }
  const doc = svgElement.ownerDocument || document;
  svgElement.setAttribute('viewBox', spec.viewBox);
  svgElement.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  const children = [];
  if (spec.scrimRect) {
    const defs = svgNode(doc, 'defs');
    const mask = svgNode(doc, 'mask', { id: maskId });
    mask.append(
      svgNode(doc, 'rect', { x: 0, y: 0, width: spec.imageWidth, height: spec.imageHeight, fill: 'white' }),
      svgNode(doc, 'rect', { x: spec.scrimRect.left, y: spec.scrimRect.top, width: spec.scrimRect.width, height: spec.scrimRect.height, fill: 'black' })
    );
    defs.append(mask);
    children.push(
      defs,
      svgNode(doc, 'rect', { class: 'locate-scrim', x: 0, y: 0, width: spec.imageWidth, height: spec.imageHeight, mask: `url(#${maskId})` })
    );
  }
  children.push(
    svgNode(doc, 'rect', { class: 'locate-bbox-halo', x: spec.bbox.left, y: spec.bbox.top, width: spec.bbox.width, height: spec.bbox.height }),
    svgNode(doc, 'rect', { class: 'locate-bbox-stroke', x: spec.bbox.left, y: spec.bbox.top, width: spec.bbox.width, height: spec.bbox.height })
  );
  if (spec.customCrop) {
    children.push(
      svgNode(doc, 'rect', { class: 'locate-crop-preview-halo', x: spec.customCrop.left, y: spec.customCrop.top, width: spec.customCrop.width, height: spec.customCrop.height }),
      svgNode(doc, 'rect', { class: 'locate-crop-preview-stroke', x: spec.customCrop.left, y: spec.customCrop.top, width: spec.customCrop.width, height: spec.customCrop.height })
    );
  }
  svgElement.replaceChildren(...children);
  svgElement.removeAttribute('hidden');
  svgElement.hidden = false;
}
