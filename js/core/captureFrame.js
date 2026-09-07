/** The centred square of the viewport that preview_render captures. */
export function captureSquare(width, height) {
    const side = Math.max(0, Math.min(width, height));
    return { left: (width - side) / 2, top: (height - side) / 2, side };
}

/** Vertical FOV (degrees) for a square render of that square; only a tall viewport narrows. */
export function captureFov(fovDeg, width, height) {
    if (!(width > 0) || !(height > 0) || width >= height) return fovDeg;
    const halfTan = Math.tan((fovDeg * Math.PI) / 360) * (width / height);
    return (Math.atan(halfTan) * 360) / Math.PI;
}
