/**
 * Axis-aligned BVH over triangle centroids for ray-mesh queries.
 * Rebuilt when mesh topology changes (see Mesh.buildOctree).
 */

const MAX_LEAF_TRIS = 6;
const MAX_DEPTH = 28;
const EPS = 1e-7;

function triBounds(vertices, faces, faceId) {
    const b = faceId * 3;
    const v0 = faces[b] * 3;
    const v1 = faces[b + 1] * 3;
    const v2 = faces[b + 2] * 3;
    let minX = vertices[v0];
    let minY = vertices[v0 + 1];
    let minZ = vertices[v0 + 2];
    let maxX = minX;
    let maxY = minY;
    let maxZ = minZ;
    for (const i of [v1, v2]) {
        const x = vertices[i];
        const y = vertices[i + 1];
        const z = vertices[i + 2];
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        minZ = Math.min(minZ, z);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        maxZ = Math.max(maxZ, z);
    }
    return { minX, minY, minZ, maxX, maxY, maxZ };
}

function unionBounds(a, b) {
    return {
        minX: Math.min(a.minX, b.minX),
        minY: Math.min(a.minY, b.minY),
        minZ: Math.min(a.minZ, b.minZ),
        maxX: Math.max(a.maxX, b.maxX),
        maxY: Math.max(a.maxY, b.maxY),
        maxZ: Math.max(a.maxZ, b.maxZ)
    };
}

function expandBoundsBox(box, margin) {
    return {
        minX: box.minX - margin,
        minY: box.minY - margin,
        minZ: box.minZ - margin,
        maxX: box.maxX + margin,
        maxY: box.maxY + margin,
        maxZ: box.maxZ + margin
    };
}

function centroidAxis(vertices, faces, faceId, axis) {
    const b = faceId * 3;
    const i0 = faces[b] * 3;
    const i1 = faces[b + 1] * 3;
    const i2 = faces[b + 2] * 3;
    const x = (vertices[i0] + vertices[i1] + vertices[i2]) / 3;
    const y = (vertices[i0 + 1] + vertices[i1 + 1] + vertices[i2 + 1]) / 3;
    const z = (vertices[i0 + 2] + vertices[i1 + 2] + vertices[i2 + 2]) / 3;
    return axis === 0 ? x : axis === 1 ? y : z;
}

function longestAxis(box) {
    const ex = box.maxX - box.minX;
    const ey = box.maxY - box.minY;
    const ez = box.maxZ - box.minZ;
    if (ex >= ey && ex >= ez) return 0;
    if (ey >= ez) return 1;
    return 2;
}

function rayAabb(ox, oy, oz, dx, dy, dz, box, tClipMax, boundsPadding = 0) {
    let t0 = 0;
    let t1 = tClipMax;
    const axes = [
        [box.minX - boundsPadding, box.maxX + boundsPadding, ox, dx],
        [box.minY - boundsPadding, box.maxY + boundsPadding, oy, dy],
        [box.minZ - boundsPadding, box.maxZ + boundsPadding, oz, dz]
    ];
    for (let i = 0; i < 3; i++) {
        const [minB, maxB, o, d] = axes[i];
        if (Math.abs(d) < EPS) {
            if (o < minB || o > maxB) return false;
            continue;
        }
        const invD = 1 / d;
        let tNear = (minB - o) * invD;
        let tFar = (maxB - o) * invD;
        if (tNear > tFar) {
            const s = tNear;
            tNear = tFar;
            tFar = s;
        }
        t0 = Math.max(t0, tNear);
        t1 = Math.min(t1, tFar);
        if (t0 > t1) return false;
    }
    return t0 <= t1;
}

function testTriangle(
    faceId,
    ox, oy, oz, dx, dy, dz,
    vertices, faces, normals,
    triangleEpsilon,
    backfaceThreshold,
    closestT
) {
    const faceBase = faceId * 3;
    const v0Idx = faces[faceBase];
    const v1Idx = faces[faceBase + 1];
    const v2Idx = faces[faceBase + 2];
    const i0 = v0Idx * 3;
    const i1 = v1Idx * 3;
    const i2 = v2Idx * 3;
    if (i2 + 2 >= vertices.length) return null;

    const v0x = vertices[i0];
    const v0y = vertices[i0 + 1];
    const v0z = vertices[i0 + 2];
    const v1x = vertices[i1];
    const v1y = vertices[i1 + 1];
    const v1z = vertices[i1 + 2];
    const v2x = vertices[i2];
    const v2y = vertices[i2 + 1];
    const v2z = vertices[i2 + 2];

    const edge1x = v1x - v0x;
    const edge1y = v1y - v0y;
    const edge1z = v1z - v0z;
    const edge2x = v2x - v0x;
    const edge2y = v2y - v0y;
    const edge2z = v2z - v0z;

    const hx = dy * edge2z - dz * edge2y;
    const hy = dz * edge2x - dx * edge2z;
    const hz = dx * edge2y - dy * edge2x;
    const a = edge1x * hx + edge1y * hy + edge1z * hz;
    if (a > -triangleEpsilon && a < triangleEpsilon) return null;

    const f = 1 / a;
    const sx = ox - v0x;
    const sy = oy - v0y;
    const sz = oz - v0z;
    const u = f * (sx * hx + sy * hy + sz * hz);
    if (u < 0 || u > 1) return null;

    const qx = sy * edge1z - sz * edge1y;
    const qy = sz * edge1x - sx * edge1z;
    const qz = sx * edge1y - sy * edge1x;
    const v = f * (dx * qx + dy * qy + dz * qz);
    if (v < 0 || u + v > 1) return null;

    const t = f * (edge2x * qx + edge2y * qy + edge2z * qz);
    if (t <= triangleEpsilon || t >= closestT) return null;

    const n0 = v0Idx * 3;
    const n1 = v1Idx * 3;
    const n2 = v2Idx * 3;
    const w = 1 - u - v;
    let nx = normals[n0] * w + normals[n1] * u + normals[n2] * v;
    let ny = normals[n0 + 1] * w + normals[n1 + 1] * u + normals[n2 + 1] * v;
    let nz = normals[n0 + 2] * w + normals[n1 + 2] * u + normals[n2 + 2] * v;
    const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nLen < 1e-10) return null;
    const invNLen = 1 / nLen;
    nx *= invNLen;
    ny *= invNLen;
    nz *= invNLen;

    const facing = nx * dx + ny * dy + nz * dz;
    if (facing >= backfaceThreshold) return null;

    return {
        t,
        point: [ox + dx * t, oy + dy * t, oz + dz * t],
        normal: [nx, ny, nz]
    };
}

function buildNode(indices, tmp, vertices, faces, begin, end, depth) {
    let box = triBounds(vertices, faces, indices[begin]);
    for (let i = begin + 1; i < end; i++) {
        box = unionBounds(box, triBounds(vertices, faces, indices[i]));
    }

    const span = Math.max(box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ);
    box = expandBoundsBox(box, span * 1e-4 + 1e-6);

    const count = end - begin;
    if (count <= MAX_LEAF_TRIS || depth >= MAX_DEPTH) {
        return { leaf: true, box, begin, end };
    }

    const axis = longestAxis(box);
    for (let i = begin; i < end; i++) {
        const fi = indices[i];
        tmp[fi] = centroidAxis(vertices, faces, fi, axis);
    }
    const mid = begin + (count >> 1);
    quickSelectByTmp(indices, tmp, begin, end - 1, mid);

    const left = buildNode(indices, tmp, vertices, faces, begin, mid, depth + 1);
    const right = buildNode(indices, tmp, vertices, faces, mid, end, depth + 1);
    return { leaf: false, box, left, right };
}

function quickSelectByTmp(indices, tmp, lo, hi, k) {
    let remaining = 2 * Math.ceil(Math.log2(hi - lo + 1));
    while (lo < hi) {
        // Bound adversarial pivot sequences; equal keys take one partition.
        if (remaining-- === 0) {
            indices.subarray(lo, hi + 1).sort((a, b) => tmp[a] - tmp[b]);
            return;
        }
        const a = tmp[indices[lo]], b = tmp[indices[(lo + hi) >>> 1]], c = tmp[indices[hi]];
        const pivotVal = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
        let lower = lo, cursor = lo, upper = hi;
        while (cursor <= upper) {
            const value = tmp[indices[cursor]];
            if (value < pivotVal) {
                const t = indices[lower];
                indices[lower++] = indices[cursor];
                indices[cursor++] = t;
            } else if (value > pivotVal) {
                const t = indices[upper];
                indices[upper--] = indices[cursor];
                indices[cursor] = t;
            } else {
                cursor++;
            }
        }
        if (k < lower) hi = lower - 1;
        else if (k > upper) lo = upper + 1;
        else return;
    }
}

export class TriangleBVH {
    constructor() {
        this.root = null;
        this._triOrder = null;
        this._tmpCentroid = null;
    }

    /**
     * @param {Float32Array} vertices
     * @param {Uint32Array} faces
     */
    build(vertices, faces) {
        const faceCount = faces.length / 3;
        if (faceCount === 0) {
            this.root = null;
            this._triOrder = null;
            return;
        }
        const indices = new Uint32Array(faceCount);
        for (let i = 0; i < faceCount; i++) indices[i] = i;
        this._tmpCentroid = new Float32Array(faceCount);
        this.root = buildNode(indices, this._tmpCentroid, vertices, faces, 0, faceCount, 0);
        this._triOrder = indices;
    }

    get isBuilt() {
        return this.root !== null;
    }

    /**
     * Update bounding boxes in place for moved vertices, keeping the existing
     * partition.
     *
     * Sculpting displaces vertices but never changes which triangle sits in
     * which leaf, so the tree stays valid and only its boxes go stale. A full
     * rebuild mid-stroke costs 11ms at 8k vertices and 879ms at 130k, enough
     * to make a dragged stroke land as separate blobs. A refit is 5-30x
     * cheaper and returns identical hits.
     *
     * Topology changes (adaptive refine, load, undo of a clay stroke) still
     * require build(): the triangle order this walks would no longer match.
     *
     * @returns {boolean} false when there is no tree to refit.
     */
    refit(vertices, faces) {
        if (!this.root || !this._triOrder) return false;
        this._refitNode(this.root, vertices, faces);
        return true;
    }

    _refitNode(node, vertices, faces) {
        const box = node.box;
        if (node.leaf) {
            let minX = Infinity, minY = Infinity, minZ = Infinity;
            let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
            for (let i = node.begin; i < node.end; i++) {
                const base = this._triOrder[i] * 3;
                for (let corner = 0; corner < 3; corner++) {
                    const v = faces[base + corner] * 3;
                    const x = vertices[v];
                    const y = vertices[v + 1];
                    const z = vertices[v + 2];
                    if (x < minX) minX = x;
                    if (y < minY) minY = y;
                    if (z < minZ) minZ = z;
                    if (x > maxX) maxX = x;
                    if (y > maxY) maxY = y;
                    if (z > maxZ) maxZ = z;
                }
            }
            // Same padding build() applies, so traversal behaves identically.
            const margin = Math.max(maxX - minX, maxY - minY, maxZ - minZ) * 1e-4 + 1e-6;
            box.minX = minX - margin;
            box.minY = minY - margin;
            box.minZ = minZ - margin;
            box.maxX = maxX + margin;
            box.maxY = maxY + margin;
            box.maxZ = maxZ + margin;
            return box;
        }

        const left = this._refitNode(node.left, vertices, faces);
        const right = this._refitNode(node.right, vertices, faces);
        box.minX = Math.min(left.minX, right.minX);
        box.minY = Math.min(left.minY, right.minY);
        box.minZ = Math.min(left.minZ, right.minZ);
        box.maxX = Math.max(left.maxX, right.maxX);
        box.maxY = Math.max(left.maxY, right.maxY);
        box.maxZ = Math.max(left.maxZ, right.maxZ);
        return box;
    }

    /**
     * Closest hit along ray direction (same semantics as SculptEngine brute path).
     */
    intersectClosest(
        ox, oy, oz, dx, dy, dz,
        vertices, faces, normals,
        triangleEpsilon,
        backfaceThreshold,
        boundsPadding = 0
    ) {
        if (!this.root) return null;
        let closestT = Infinity;
        let best = null;
        const stack = [this.root];
        while (stack.length > 0) {
            const node = stack.pop();
            if (!rayAabb(ox, oy, oz, dx, dy, dz, node.box, closestT, boundsPadding)) continue;
            if (node.leaf) {
                for (let i = node.begin; i < node.end; i++) {
                    const faceId = this._triOrder[i];
                    const hit = testTriangle(
                        faceId,
                        ox, oy, oz, dx, dy, dz,
                        vertices, faces, normals,
                        triangleEpsilon,
                        backfaceThreshold,
                        closestT
                    );
                    if (hit) {
                        closestT = hit.t;
                        best = hit;
                    }
                }
            } else {
                stack.push(node.right, node.left);
            }
        }
        if (!best) return null;
        return {
            point: best.point,
            normal: best.normal
        };
    }
}
