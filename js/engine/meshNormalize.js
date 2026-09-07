/**
 * Center mesh at origin and scale to fit a unit bounding sphere (matches OBJ import behavior).
 * @param {number[]} vertices - Flat xyz array, mutated in place
 */
export function normalizeVerticesToUnitSphere(vertices) {
    const vertCount = vertices.length / 3;
    if (vertCount === 0) {
        return;
    }

    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < vertCount; i++) {
        cx += vertices[i * 3];
        cy += vertices[i * 3 + 1];
        cz += vertices[i * 3 + 2];
    }
    cx /= vertCount;
    cy /= vertCount;
    cz /= vertCount;

    let maxDistSq = 0;
    for (let i = 0; i < vertCount; i++) {
        const dx = vertices[i * 3] - cx;
        const dy = vertices[i * 3 + 1] - cy;
        const dz = vertices[i * 3 + 2] - cz;
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq > maxDistSq) {
            maxDistSq = distSq;
        }
    }

    const scale = maxDistSq > 0 ? 1.0 / Math.sqrt(maxDistSq) : 1.0;
    for (let i = 0; i < vertCount; i++) {
        vertices[i * 3] = (vertices[i * 3] - cx) * scale;
        vertices[i * 3 + 1] = (vertices[i * 3 + 1] - cy) * scale;
        vertices[i * 3 + 2] = (vertices[i * 3 + 2] - cz) * scale;
    }
}
