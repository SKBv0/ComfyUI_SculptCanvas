/**
 * Mesh data structure for sculpting
 * Stores vertices, normals, faces, and adjacency information
 */

import { TriangleBVH } from "./TriangleBVH.js";
import { MAX_IMPORT_VERTEX_COUNT, MAX_MESH_FACE_INDICES } from "./limits.js";

export const MAX_ABS_VERTEX_COORDINATE = 1_000_000;

/**
 * Octree node for spatial indexing - O(log n) vertex queries
 */
class OctreeNode {
    constructor(minX, minY, minZ, maxX, maxY, maxZ, depth = 0) {
        this.minX = minX;
        this.minY = minY;
        this.minZ = minZ;
        this.maxX = maxX;
        this.maxY = maxY;
        this.maxZ = maxZ;
        this.depth = depth;
        this.vertices = [];  // Vertex indices stored in this node
        this.children = null;  // 8 child nodes when subdivided
    }

    get centerX() { return (this.minX + this.maxX) * 0.5; }
    get centerY() { return (this.minY + this.maxY) * 0.5; }
    get centerZ() { return (this.minZ + this.maxZ) * 0.5; }

    /**
     * Check if a sphere intersects this node's bounding box
     */
    intersectsSphere(cx, cy, cz, radius) {
        // Find closest point on AABB to sphere center
        const closestX = Math.max(this.minX, Math.min(cx, this.maxX));
        const closestY = Math.max(this.minY, Math.min(cy, this.maxY));
        const closestZ = Math.max(this.minZ, Math.min(cz, this.maxZ));

        const dx = cx - closestX;
        const dy = cy - closestY;
        const dz = cz - closestZ;

        return (dx * dx + dy * dy + dz * dz) <= (radius * radius);
    }

    /**
     * Get child index for a point (0-7)
     */
    getChildIndex(x, y, z) {
        let index = 0;
        if (x >= this.centerX) index |= 1;
        if (y >= this.centerY) index |= 2;
        if (z >= this.centerZ) index |= 4;
        return index;
    }

    /**
     * Subdivide into 8 children
     */
    subdivide() {
        this.children = [];
        const cx = this.centerX, cy = this.centerY, cz = this.centerZ;
        const newDepth = this.depth + 1;

        for (let i = 0; i < 8; i++) {
            const minX = (i & 1) ? cx : this.minX;
            const maxX = (i & 1) ? this.maxX : cx;
            const minY = (i & 2) ? cy : this.minY;
            const maxY = (i & 2) ? this.maxY : cy;
            const minZ = (i & 4) ? cz : this.minZ;
            const maxZ = (i & 4) ? this.maxZ : cz;

            this.children.push(new OctreeNode(minX, minY, minZ, maxX, maxY, maxZ, newDepth));
        }
    }
}

/**
 * Octree for fast spatial queries
 */
class Octree {
    constructor(maxDepth = 6, maxVerticesPerNode = 16) {
        this.root = null;
        this.maxDepth = maxDepth;
        this.maxVerticesPerNode = maxVerticesPerNode;
        this.mesh = null;
    }

    /**
     * Build octree from mesh
     */
    build(mesh) {
        this.mesh = mesh;
        if (!mesh.vertices || mesh.vertexCount === 0) {
            this.root = null;
            return;
        }

        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (let i = 0; i < mesh.vertexCount; i++) {
            const x = mesh.vertices[i * 3];
            const y = mesh.vertices[i * 3 + 1];
            const z = mesh.vertices[i * 3 + 2];
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            minZ = Math.min(minZ, z);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
            maxZ = Math.max(maxZ, z);
        }

        // Pad the root so vertices exactly on the bounds still fall inside it,
        // and so a flat mesh does not produce a zero-width axis.
        const padding = Math.max(maxX - minX, maxY - minY, maxZ - minZ) * 0.1 + 0.01;
        this.root = new OctreeNode(
            minX - padding, minY - padding, minZ - padding,
            maxX + padding, maxY + padding, maxZ + padding
        );

        for (let i = 0; i < mesh.vertexCount; i++) {
            this._insert(this.root, i,
                mesh.vertices[i * 3],
                mesh.vertices[i * 3 + 1],
                mesh.vertices[i * 3 + 2]
            );
        }
    }

    _insert(node, vertexIndex, x, y, z) {
        if (!node.children) {
            node.vertices.push(vertexIndex);

            if (node.vertices.length > this.maxVerticesPerNode && node.depth < this.maxDepth) {
                node.subdivide();

                const oldVertices = node.vertices;
                node.vertices = [];

                for (const vIdx of oldVertices) {
                    const vx = this.mesh.vertices[vIdx * 3];
                    const vy = this.mesh.vertices[vIdx * 3 + 1];
                    const vz = this.mesh.vertices[vIdx * 3 + 2];
                    const childIdx = node.getChildIndex(vx, vy, vz);
                    this._insert(node.children[childIdx], vIdx, vx, vy, vz);
                }
            }
            return;
        }

        const childIdx = node.getChildIndex(x, y, z);
        this._insert(node.children[childIdx], vertexIndex, x, y, z);
    }

    /**
     * Query all vertices within radius of center point
     * Returns array of vertex indices
     */
    queryRadius(centerX, centerY, centerZ, radius, boundsPadding = 0) {
        if (!this.root) return [];

        const results = [];
        const boundsRadius = radius + Math.max(0, boundsPadding);
        this._queryRadius(this.root, centerX, centerY, centerZ, boundsRadius, radius * radius, results);
        return results;
    }

    _queryRadius(node, cx, cy, cz, radius, radiusSq, results) {
        if (!node.intersectsSphere(cx, cy, cz, radius)) {
            return;
        }

        for (const vIdx of node.vertices) {
            const vx = this.mesh.vertices[vIdx * 3];
            const vy = this.mesh.vertices[vIdx * 3 + 1];
            const vz = this.mesh.vertices[vIdx * 3 + 2];

            const dx = vx - cx;
            const dy = vy - cy;
            const dz = vz - cz;
            const distSq = dx * dx + dy * dy + dz * dz;

            if (distSq <= radiusSq) {
                results.push(vIdx);
            }
        }

        if (node.children) {
            for (const child of node.children) {
                this._queryRadius(child, cx, cy, cz, radius, radiusSq, results);
            }
        }
    }
}

export class Mesh {
    constructor() {
        this.vertices = [];      // [x,y,z, x,y,z, ...] flat Float32Array
        this.normals = [];       // Per-vertex normals
        this.faces = [];         // [v0,v1,v2, ...] triangle indices
        this.neighbors = null;   // Adjacency list for smooth brush
        this.edgeLengths = null; // Per-vertex average edge length for adaptive brush clamping
        this.vertexFaces = null; // Vertex to face mapping for incremental normals
        this.octree = null;      // Spatial index for O(log n) queries
        this.vertexCount = 0;
        this.faceCount = 0;
        this.normalOrientationSign = 1;
        this._orientationSignEstimated = false;
        this._vertexScratchMarks = null;
        this._vertexScratchStamp = 0;
        this._faceScratchMarks = null;
        this._faceScratchStamp = 0;
        this._scratchVertexList = [];
        this._scratchFaceList = [];
        this.topologyRevision = 0;
        this.triangleBVH = new TriangleBVH();
        // Conservative displacement since the last octree/BVH refresh. It lets
        // queries use current vertex positions without missing geometry that
        // moved outside stale node bounds during an active stroke.
        this.spatialIndexPadding = 0;
        this.uvs = null;
        this.vertexOwners = null;
        this.coincidentGroups = [];
        this.coincidentGroupByVertex = null;
        this.vertexMask = null;
    }

    ensureVertexMask() {
        if (!this.vertexMask || this.vertexMask.length !== this.vertexCount) {
            this.vertexMask = new Float32Array(this.vertexCount);
        }
    }

    /**
     * Initialize mesh from vertex and face arrays
     */
    setData(vertices, faces, uvs = null, vertexOwners = null) {
        // Reject before allocating buffers or building spatial indices.
        if (vertices.length > MAX_IMPORT_VERTEX_COUNT * 3 || faces.length > MAX_MESH_FACE_INDICES) {
            throw new Error("Sculpt mesh exceeds the supported vertex or face limit");
        }
        if ((vertices.length || faces.length) && (vertices.length < 9 || faces.length < 3)) {
            throw new Error("Sculpt mesh must contain at least one triangle");
        }
        if (vertices.length % 3 !== 0) {
            throw new Error(`[Sculpt] setData: vertices.length (${vertices.length}) must be divisible by 3`);
        }
        if (faces.length % 3 !== 0) {
            throw new Error(`[Sculpt] setData: faces.length (${faces.length}) must be divisible by 3 (triangle list)`);
        }
        const expectedVC = vertices.length / 3;
        for (let i = 0; i < faces.length; i++) {
            const f = faces[i];
            if (!Number.isInteger(f) || f < 0 || f >= expectedVC) {
                throw new Error(`[Sculpt] setData: face index ${f} is invalid (vertexCount=${expectedVC})`);
            }
        }
        for (let i = 0; i < vertices.length; i++) {
            if (
                !Number.isFinite(vertices[i]) ||
                Math.abs(vertices[i]) > MAX_ABS_VERTEX_COORDINATE
            ) {
                throw new Error(`[Sculpt] setData: vertex value at index ${i} is not finite`);
            }
        }
        if (uvs) {
            if (uvs.length !== expectedVC * 2) throw new Error("Sculpt UVs must match the vertex count");
            for (const value of uvs) {
                if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) {
                    throw new Error("Sculpt UVs must be finite pairs");
                }
            }
        }
        if (vertexOwners) {
            if (vertexOwners.length !== expectedVC) {
                throw new Error("Sculpt vertex owners must match the vertex count");
            }
            for (const value of vertexOwners) {
                if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
                    throw new Error("Sculpt vertex owners must be unsigned integers");
                }
            }
        }
        this.vertices = new Float32Array(vertices);
        this.faces = new Uint32Array(faces);
        this.vertexCount = this.vertices.length / 3;
        this.faceCount = this.faces.length / 3;
        this.uvs = null;
        if (uvs && uvs.length === this.vertexCount * 2) {
            this.uvs = uvs instanceof Float32Array ? uvs : new Float32Array(uvs);
        }
        this.vertexOwners = vertexOwners && vertexOwners.length === this.vertexCount
            ? (vertexOwners instanceof Uint32Array ? vertexOwners : new Uint32Array(vertexOwners))
            : null;
        this._rebuildCoincidentGroups();
        this._resetScratchBuffers();
        this.topologyRevision++;

        // New external geometry is the one place the winding convention is
        // unknown, so derive the orientation sign here and hold it.
        this.recalculateNormals(true);
        this.buildAdjacency();
        this.computeEdgeLengths();
        this.buildVertexFaces();
        this.buildOctree();
        this.vertexMask = new Float32Array(this.vertexCount);
    }

    applyVertexMaskFromArray(arr) {
        if (!arr || !this.vertexCount) return;
        const n = this.vertexCount;
        this.ensureVertexMask();
        const len = Math.min(n, arr.length);
        for (let i = 0; i < len; i++) {
            const v = Number(arr[i]);
            this.vertexMask[i] = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
        }
        this.synchronizeCoincidentMask();
    }

    clearMask() {
        this.ensureVertexMask();
        this.vertexMask.fill(0);
    }

    invertMask() {
        this.ensureVertexMask();
        for (let i = 0; i < this.vertexCount; i++) {
            this.vertexMask[i] = 1 - this.vertexMask[i];
        }
    }

    blurMask(iterations = 1) {
        if (!this.neighbors || this.vertexCount === 0) return;
        this.ensureVertexMask();
        const iters = Math.max(1, Math.min(4, iterations));
        const cur = new Float32Array(this.vertexMask);
        const next = new Float32Array(this.vertexCount);
        for (let iter = 0; iter < iters; iter++) {
            for (let i = 0; i < this.vertexCount; i++) {
                const neighbors = this.neighbors[i];
                if (!neighbors || neighbors.length === 0) {
                    next[i] = cur[i];
                    continue;
                }
                let s = cur[i];
                let c = 1;
                for (const n of neighbors) {
                    if (n >= 0 && n < this.vertexCount) {
                        s += cur[n];
                        c++;
                    }
                }
                next[i] = Math.max(0, Math.min(1, s / c));
            }
            cur.set(next);
        }
        this.vertexMask.set(cur);
        for (let i = 0; i < this.vertexCount; i++) {
            const m = this.vertexMask[i];
            if (m >= 0.8) {
                this.vertexMask[i] = Math.min(1, m + (1 - m) * 0.5);
            }
        }
        this.synchronizeCoincidentMask();
    }

    /**
     * UV seams and hard-normal boundaries duplicate render vertices at the
     * same object-space point. Keep those duplicates as one sculpt vertex
     * without welding distinct imported objects together.
     */
    _rebuildCoincidentGroups() {
        this.coincidentGroups = [];
        this.coincidentGroupByVertex = new Int32Array(this.vertexCount);
        this.coincidentGroupByVertex.fill(-1);
        if (this.vertexCount < 2) return;

        const byPoint = new Map();
        for (let i = 0; i < this.vertexCount; i++) {
            const vi = i * 3;
            const owner = this.vertexOwners ? this.vertexOwners[i] : 0;
            const key = `${owner}|${this.vertices[vi]}|${this.vertices[vi + 1]}|${this.vertices[vi + 2]}`;
            const group = byPoint.get(key);
            if (group) group.push(i);
            else byPoint.set(key, [i]);
        }
        for (const members of byPoint.values()) {
            if (members.length < 2) continue;
            const groupIndex = this.coincidentGroups.length;
            this.coincidentGroups.push(members);
            for (const index of members) this.coincidentGroupByVertex[index] = groupIndex;
        }
    }

    expandCoincidentAffected(entries) {
        if (!entries?.length || this.coincidentGroups.length === 0) return entries || [];
        const falloffByIndex = new Map(entries.map((entry) => [entry.index, entry.falloff]));
        const touchedGroups = new Map();
        for (const entry of entries) {
            const groupIndex = this.coincidentGroupByVertex?.[entry.index] ?? -1;
            if (groupIndex < 0) continue;
            touchedGroups.set(groupIndex, Math.max(touchedGroups.get(groupIndex) || 0, entry.falloff));
        }
        for (const [groupIndex, falloff] of touchedGroups) {
            for (const index of this.coincidentGroups[groupIndex]) {
                falloffByIndex.set(index, Math.max(falloffByIndex.get(index) || 0, falloff));
            }
        }
        return Array.from(falloffByIndex, ([index, falloff]) => ({ index, falloff }));
    }

    synchronizeCoincidentVertices(indices) {
        if (!indices?.length || this.coincidentGroups.length === 0) return;
        const touched = new Set();
        for (const index of indices) {
            const groupIndex = this.coincidentGroupByVertex?.[index] ?? -1;
            if (groupIndex >= 0) touched.add(groupIndex);
        }
        for (const groupIndex of touched) {
            const members = this.coincidentGroups[groupIndex];
            let x = 0, y = 0, z = 0;
            for (const index of members) {
                const vi = index * 3;
                x += this.vertices[vi];
                y += this.vertices[vi + 1];
                z += this.vertices[vi + 2];
            }
            x /= members.length;
            y /= members.length;
            z /= members.length;
            for (const index of members) {
                const vi = index * 3;
                this.vertices[vi] = x;
                this.vertices[vi + 1] = y;
                this.vertices[vi + 2] = z;
            }
        }
    }

    synchronizeCoincidentMask() {
        if (!this.vertexMask || this.coincidentGroups.length === 0) return;
        for (const members of this.coincidentGroups) {
            let value = 0;
            for (const index of members) value = Math.max(value, this.vertexMask[index]);
            for (const index of members) this.vertexMask[index] = value;
        }
    }

    /**
     * Compute average edge length per vertex.
     * If indices are given, update those and their neighbors only.
     */
    computeEdgeLengths(indices = null) {
        if (this.vertexCount === 0) {
            this.edgeLengths = new Float32Array(0);
            return;
        }

        if (!this.edgeLengths || this.edgeLengths.length !== this.vertexCount) {
            this.edgeLengths = new Float32Array(this.vertexCount);
        }

        const computeOne = (idx) => {
            const neighbors = this.neighbors?.[idx];
            if (!neighbors || neighbors.length === 0) {
                this.edgeLengths[idx] = 0.02;
                return;
            }

            const i = idx * 3;
            const px = this.vertices[i];
            const py = this.vertices[i + 1];
            const pz = this.vertices[i + 2];
            let sum = 0;
            let count = 0;

            for (const n of neighbors) {
                if (n < 0 || n >= this.vertexCount) continue;
                const ni = n * 3;
                const dx = this.vertices[ni] - px;
                const dy = this.vertices[ni + 1] - py;
                const dz = this.vertices[ni + 2] - pz;
                sum += Math.sqrt(dx * dx + dy * dy + dz * dz);
                count++;
            }

            this.edgeLengths[idx] = count > 0 ? (sum / count) : 0.02;
        };

        if (!indices || indices.length === 0) {
            for (let i = 0; i < this.vertexCount; i++) computeOne(i);
            return;
        }

        const toUpdate = this._scratchVertexList;
        toUpdate.length = 0;
        const { marks, stamp } = this._nextVertexScratchMark();
        const markVertex = (idx) => {
            if (idx < 0 || idx >= this.vertexCount) return;
            if (marks[idx] === stamp) return;
            marks[idx] = stamp;
            toUpdate.push(idx);
        };

        for (const idx of indices) {
            markVertex(idx);
            const neighbors = this.neighbors?.[idx];
            if (!neighbors) continue;
            for (const n of neighbors) markVertex(n);
        }

        for (const idx of toUpdate) {
            computeOne(idx);
        }
    }

    getEdgeScale(index) {
        if (!this.edgeLengths || index < 0 || index >= this.edgeLengths.length) {
            return 0.02;
        }
        const s = this.edgeLengths[index];
        return Number.isFinite(s) && s > 1e-6 ? s : 0.02;
    }

    /**
     * Build vertex-to-face mapping for incremental normal updates
     */
    buildVertexFaces() {
        if (this.vertexCount === 0) {
            this.vertexFaces = [];
            return;
        }

        this.vertexFaces = new Array(this.vertexCount);
        for (let i = 0; i < this.vertexCount; i++) {
            this.vertexFaces[i] = [];
        }

        for (let faceIdx = 0; faceIdx < this.faceCount; faceIdx++) {
            const baseIdx = faceIdx * 3;
            const v0 = this.faces[baseIdx];
            const v1 = this.faces[baseIdx + 1];
            const v2 = this.faces[baseIdx + 2];

            if (v0 < this.vertexCount) this.vertexFaces[v0].push(faceIdx);
            if (v1 < this.vertexCount) this.vertexFaces[v1].push(faceIdx);
            if (v2 < this.vertexCount) this.vertexFaces[v2].push(faceIdx);
        }
    }

    /**
     * Rebuild the spatial indices after topology changed (load, refine, undo of
     * a topology-changing stroke).
     */
    buildOctree() {
        this.octree = new Octree(6, 16);
        this.octree.build(this);
        if (this.faceCount > 0 && this.vertices?.length && this.faces?.length) {
            this.triangleBVH.build(this.vertices, this.faces);
        }
        this.spatialIndexPadding = 0;
    }

    /**
     * Refresh the spatial indices after a stroke moved vertices without
     * changing topology. The octree is rebuilt outright because that is cheap;
     * the BVH is refit and only falls back to a full build if the refit
     * reports the tree no longer matches. See TriangleBVH.refit for why
     * refitting is valid and what it costs.
     */
    refreshSpatialIndexForMovedVertices() {
        this.octree = new Octree(6, 16);
        this.octree.build(this);
        if (this.faceCount > 0 && this.vertices?.length && this.faces?.length) {
            if (!this.triangleBVH.refit(this.vertices, this.faces)) {
                this.triangleBVH.build(this.vertices, this.faces);
            }
        }
        this.spatialIndexPadding = 0;
    }

    noteSpatialMovement(indices, beforePositions) {
        if (!indices || !beforePositions || indices.length * 3 > beforePositions.length) return;
        let maxDabDisplacement = 0;
        for (let n = 0; n < indices.length; n++) {
            const idx = indices[n];
            if (idx < 0 || idx >= this.vertexCount) continue;
            const vi = idx * 3;
            const bi = n * 3;
            const dx = this.vertices[vi] - beforePositions[bi];
            const dy = this.vertices[vi + 1] - beforePositions[bi + 1];
            const dz = this.vertices[vi + 2] - beforePositions[bi + 2];
            maxDabDisplacement = Math.max(maxDabDisplacement, Math.hypot(dx, dy, dz));
        }
        // The sum of per-dab maxima is a conservative upper bound for every
        // vertex's displacement from the positions stored in both indices.
        this.spatialIndexPadding += maxDabDisplacement;
    }

    /**
     * Recalculate vertex normals by averaging face normals.
     *
     * @param {boolean} reestimateOrientation Re-derive the global normal
     *   orientation sign. Only true when genuinely new geometry arrives
     *   (`setData`); sculpting, refine, and undo all preserve face winding, so
     *   they must keep the sign they were loaded with. Re-estimating per stroke
     *   flips every normal on a flat mesh; see `_estimateNormalOrientationSign`.
     */
    recalculateNormals(reestimateOrientation = false) {
        this.normals = new Float32Array(this.vertices.length);
        const vertices = this.vertices;
        const faces = this.faces;
        const normals = this.normals;
        // Accumulate face normals to each vertex.
        for (let i = 0; i < faces.length; i += 3) {
            const i0 = faces[i] * 3;
            const i1 = faces[i + 1] * 3;
            const i2 = faces[i + 2] * 3;

            const v0x = vertices[i0], v0y = vertices[i0 + 1], v0z = vertices[i0 + 2];
            const v1x = vertices[i1], v1y = vertices[i1 + 1], v1z = vertices[i1 + 2];
            const v2x = vertices[i2], v2y = vertices[i2 + 1], v2z = vertices[i2 + 2];

            const e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
            const e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;

            const nx = e1y * e2z - e1z * e2y;
            const ny = e1z * e2x - e1x * e2z;
            const nz = e1x * e2y - e1y * e2x;

            normals[i0] += nx;
            normals[i0 + 1] += ny;
            normals[i0 + 2] += nz;

            normals[i1] += nx;
            normals[i1 + 1] += ny;
            normals[i1 + 2] += nz;

            normals[i2] += nx;
            normals[i2 + 1] += ny;
            normals[i2 + 2] += nz;
        }

        for (let i = 0; i < normals.length; i += 3) {
            const nx = normals[i];
            const ny = normals[i + 1];
            const nz = normals[i + 2];

            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (len > 0) {
                normals[i] = nx / len;
                normals[i + 1] = ny / len;
                normals[i + 2] = nz / len;
            }
        }

        // Keep a consistent global normal orientation to avoid local flip seams.
        if (reestimateOrientation || !this._orientationSignEstimated) {
            this.normalOrientationSign = this._estimateNormalOrientationSign();
            this._orientationSignEstimated = true;
        }
        const sign = this.normalOrientationSign;
        if (sign < 0) {
            for (let i = 0; i < this.normals.length; i++) {
                this.normals[i] = -this.normals[i];
            }
        }
    }

    /**
     * Recalculate normals only for affected vertices and their neighbors
     * Much faster than full recalculation - O(affected) vs O(all)
     */
    recalculateNormalsPartial(affectedIndices) {
        if (!affectedIndices || affectedIndices.length === 0 || !this.vertexFaces) {
            return [];
        }

        // Expand affected set to include neighbors (since face normals changed)
        const toUpdate = this._scratchVertexList;
        toUpdate.length = 0;
        const affectedFaces = this._scratchFaceList;
        affectedFaces.length = 0;

        const vertexScratch = this._nextVertexScratchMark();
        const vertexMarks = vertexScratch.marks;
        const vertexStamp = vertexScratch.stamp;
        const faceScratch = this._nextFaceScratchMark();
        const faceMarks = faceScratch.marks;
        const faceStamp = faceScratch.stamp;

        const markVertex = (idx) => {
            if (idx < 0 || idx >= this.vertexCount) return;
            if (vertexMarks[idx] === vertexStamp) return;
            vertexMarks[idx] = vertexStamp;
            toUpdate.push(idx);
        };

        for (const idx of affectedIndices) {
            markVertex(idx);
            if (this.neighbors && this.neighbors[idx]) {
                for (const neighbor of this.neighbors[idx]) {
                    markVertex(neighbor);
                }
            }
        }

        for (const vIdx of toUpdate) {
            const linkedFaces = this.vertexFaces[vIdx];
            if (!linkedFaces) continue;
            for (const faceIdx of linkedFaces) {
                if (faceIdx < 0 || faceIdx >= this.faceCount) continue;
                if (faceMarks[faceIdx] === faceStamp) continue;
                faceMarks[faceIdx] = faceStamp;
                affectedFaces.push(faceIdx);
            }
        }

        // Keep the old normals: a vertex whose faces cancel out to zero length
        // below falls back to them instead of losing its orientation.
        const prevNormals = new Float32Array(toUpdate.length * 3);
        let prevPtr = 0;
        for (const vIdx of toUpdate) {
            const i = vIdx * 3;
            prevNormals[prevPtr++] = this.normals[i];
            prevNormals[prevPtr++] = this.normals[i + 1];
            prevNormals[prevPtr++] = this.normals[i + 2];
            this.normals[i] = 0;
            this.normals[i + 1] = 0;
            this.normals[i + 2] = 0;
        }

        for (const faceIdx of affectedFaces) {
            const baseIdx = faceIdx * 3;
            const v0Idx = this.faces[baseIdx];
            const v1Idx = this.faces[baseIdx + 1];
            const v2Idx = this.faces[baseIdx + 2];

            const i0 = v0Idx * 3;
            const i1 = v1Idx * 3;
            const i2 = v2Idx * 3;

            const v0x = this.vertices[i0], v0y = this.vertices[i0 + 1], v0z = this.vertices[i0 + 2];
            const v1x = this.vertices[i1], v1y = this.vertices[i1 + 1], v1z = this.vertices[i1 + 2];
            const v2x = this.vertices[i2], v2y = this.vertices[i2 + 1], v2z = this.vertices[i2 + 2];

            const e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
            const e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;

            const nx = e1y * e2z - e1z * e2y;
            const ny = e1z * e2x - e1x * e2z;
            const nz = e1x * e2y - e1y * e2x;

            // Vertices outside the update set keep their existing normal, so
            // only accumulate into the ones that were zeroed above.
            if (vertexMarks[v0Idx] === vertexStamp) {
                this.normals[i0] += nx;
                this.normals[i0 + 1] += ny;
                this.normals[i0 + 2] += nz;
            }
            if (vertexMarks[v1Idx] === vertexStamp) {
                this.normals[i1] += nx;
                this.normals[i1 + 1] += ny;
                this.normals[i1 + 2] += nz;
            }
            if (vertexMarks[v2Idx] === vertexStamp) {
                this.normals[i2] += nx;
                this.normals[i2 + 1] += ny;
                this.normals[i2 + 2] += nz;
            }
        }

        const orientSign = this.normalOrientationSign || 1;
        prevPtr = 0;
        for (const vIdx of toUpdate) {
            const i = vIdx * 3;
            const nx = this.normals[i];
            const ny = this.normals[i + 1];
            const nz = this.normals[i + 2];

            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (len > 0) {
                this.normals[i] = (nx / len) * orientSign;
                this.normals[i + 1] = (ny / len) * orientSign;
                this.normals[i + 2] = (nz / len) * orientSign;
            } else {
                const pnx = prevNormals[prevPtr];
                const pny = prevNormals[prevPtr + 1];
                const pnz = prevNormals[prevPtr + 2];
                const plen = Math.sqrt(pnx * pnx + pny * pny + pnz * pnz);
                if (plen > 1e-8) {
                    this.normals[i] = (pnx / plen) * orientSign;
                    this.normals[i + 1] = (pny / plen) * orientSign;
                    this.normals[i + 2] = (pnz / plen) * orientSign;
                } else {
                    this.normals[i] = 0;
                    this.normals[i + 1] = orientSign;
                    this.normals[i + 2] = 0;
                }
            }
            prevPtr += 3;
        }
        // The renderer needs the expanded one-ring, not just the vertices whose
        // positions moved. Return a copy because `toUpdate` is shared scratch
        // storage and will be reused by the next mesh operation.
        return toUpdate.slice();
    }

    _resetScratchBuffers() {
        this._vertexScratchMarks = this.vertexCount > 0 ? new Int32Array(this.vertexCount) : null;
        this._vertexScratchStamp = 0;
        this._faceScratchMarks = this.faceCount > 0 ? new Int32Array(this.faceCount) : null;
        this._faceScratchStamp = 0;
        this._scratchVertexList.length = 0;
        this._scratchFaceList.length = 0;
    }

    _nextVertexScratchMark() {
        if (!this._vertexScratchMarks || this._vertexScratchMarks.length !== this.vertexCount) {
            this._vertexScratchMarks = new Int32Array(this.vertexCount);
            this._vertexScratchStamp = 0;
        }
        this._vertexScratchStamp++;
        if (this._vertexScratchStamp <= 0) {
            this._vertexScratchMarks.fill(0);
            this._vertexScratchStamp = 1;
        }
        return { marks: this._vertexScratchMarks, stamp: this._vertexScratchStamp };
    }

    _nextFaceScratchMark() {
        if (!this._faceScratchMarks || this._faceScratchMarks.length !== this.faceCount) {
            this._faceScratchMarks = new Int32Array(this.faceCount);
            this._faceScratchStamp = 0;
        }
        this._faceScratchStamp++;
        if (this._faceScratchStamp <= 0) {
            this._faceScratchMarks.fill(0);
            this._faceScratchStamp = 1;
        }
        return { marks: this._faceScratchMarks, stamp: this._faceScratchStamp };
    }

    /**
     * Guess whether face winding produces outward or inward normals, by
     * correlating normals with the outward direction from the centroid.
     *
     * This is only meaningful for closed volumes. On a flat sheet every
     * (v - centroid) is in-plane and the score is exactly 0, so the result sits
     * on a knife edge: displacing the surface even slightly to one side tips
     * the sum negative. That is why the sign is estimated once per loaded mesh
     * rather than on every recalculateNormals(); see the caller.
     */
    _estimateNormalOrientationSign() {
        if (!this.vertices || this.vertexCount === 0 || !this.normals) return 1;

        let cx = 0, cy = 0, cz = 0;
        for (let i = 0; i < this.vertices.length; i += 3) {
            cx += this.vertices[i];
            cy += this.vertices[i + 1];
            cz += this.vertices[i + 2];
        }
        cx /= this.vertexCount;
        cy /= this.vertexCount;
        cz /= this.vertexCount;

        let score = 0;
        const sampleCount = Math.min(this.vertexCount, 256);
        const step = Math.max(1, Math.floor(this.vertexCount / sampleCount));
        for (let i = 0; i < this.vertexCount; i += step) {
            const vi = i * 3;
            const vx = this.vertices[vi] - cx;
            const vy = this.vertices[vi + 1] - cy;
            const vz = this.vertices[vi + 2] - cz;
            score += this.normals[vi] * vx + this.normals[vi + 1] * vy + this.normals[vi + 2] * vz;
        }

        return score >= 0 ? 1 : -1;
    }

    /**
     * Build vertex adjacency list for smooth brush
     */
    buildAdjacency() {
        if (this.vertexCount === 0) {
            this.neighbors = [];
            return;
        }

        this.neighbors = new Array(this.vertexCount);

        for (let i = 0; i < this.vertexCount; i++) {
            this.neighbors[i] = new Set();
        }

        for (let i = 0; i < this.faces.length; i += 3) {
            const v0 = this.faces[i];
            const v1 = this.faces[i + 1];
            const v2 = this.faces[i + 2];

            if (v0 >= this.vertexCount || v1 >= this.vertexCount || v2 >= this.vertexCount) {
                continue;
            }

            this.neighbors[v0].add(v1);
            this.neighbors[v0].add(v2);
            this.neighbors[v1].add(v0);
            this.neighbors[v1].add(v2);
            this.neighbors[v2].add(v0);
            this.neighbors[v2].add(v1);
        }

        for (let i = 0; i < this.vertexCount; i++) {
            this.neighbors[i] = Array.from(this.neighbors[i]);
        }

        // Cross UV/hard-normal seams inside the same imported object. Faces
        // keep their distinct render vertices and UVs, while brush traversal
        // sees one continuous sculpt surface.
        for (const members of this.coincidentGroups) {
            const united = new Set(members);
            for (const index of members) {
                for (const neighbor of this.neighbors[index] || []) united.add(neighbor);
            }
            for (const index of members) {
                this.neighbors[index] = Array.from(united).filter((neighbor) => neighbor !== index);
            }
        }
    }

    /**
     * Get vertex position
     */
    getVertex(index) {
        const i = index * 3;
        return [this.vertices[i], this.vertices[i + 1], this.vertices[i + 2]];
    }

    /**
     * Set vertex position
     */
    setVertex(index, x, y, z) {
        const i = index * 3;
        this.vertices[i] = x;
        this.vertices[i + 1] = y;
        this.vertices[i + 2] = z;
    }

    /**
     * Get vertex normal
     */
    getNormal(index) {
        const i = index * 3;
        return [this.normals[i], this.normals[i + 1], this.normals[i + 2]];
    }

    /**
     * Query candidate vertices near a point using octree if available.
     */
    queryVerticesInRadius(centerX, centerY, centerZ, radius) {
        if (this.octree) {
            return this.octree.queryRadius(centerX, centerY, centerZ, radius, this.spatialIndexPadding);
        }

        const radiusSq = radius * radius;
        const result = [];
        for (let i = 0; i < this.vertexCount; i++) {
            const idx = i * 3;
            const dx = this.vertices[idx] - centerX;
            const dy = this.vertices[idx + 1] - centerY;
            const dz = this.vertices[idx + 2] - centerZ;
            if (dx * dx + dy * dy + dz * dz <= radiusSq) {
                result.push(i);
            }
        }
        return result;
    }

    cloneState() {
        const snap = {
            vertices: new Float32Array(this.vertices),
            faces: new Uint32Array(this.faces)
        };
        if (this.uvs && this.uvs.length === this.vertexCount * 2) {
            snap.uvs = new Float32Array(this.uvs);
        }
        if (this.vertexOwners && this.vertexOwners.length === this.vertexCount) {
            snap.vertexOwners = new Uint32Array(this.vertexOwners);
        }
        this.ensureVertexMask();
        snap.vertexMask = new Float32Array(this.vertexMask);
        return snap;
    }

    restoreState(snapshot) {
        if (!snapshot || !snapshot.vertices || !snapshot.faces) return;
        this.vertices = new Float32Array(snapshot.vertices);
        this.faces = new Uint32Array(snapshot.faces);
        this.vertexCount = this.vertices.length / 3;
        this.faceCount = this.faces.length / 3;
        this.uvs = null;
        if (snapshot.uvs && snapshot.uvs.length === this.vertexCount * 2) {
            this.uvs = new Float32Array(snapshot.uvs);
        }
        this.vertexOwners = snapshot.vertexOwners && snapshot.vertexOwners.length === this.vertexCount
            ? new Uint32Array(snapshot.vertexOwners)
            : null;
        this._rebuildCoincidentGroups();
        if (snapshot.vertexMask && snapshot.vertexMask.length === this.vertexCount) {
            this.vertexMask = new Float32Array(snapshot.vertexMask);
        } else {
            this.vertexMask = new Float32Array(this.vertexCount);
        }
        this.synchronizeCoincidentMask();
        this._resetScratchBuffers();
        this.topologyRevision++;
        this.recalculateNormals();
        this.buildAdjacency();
        this.computeEdgeLengths();
        this.buildVertexFaces();
        this.buildOctree();
    }

    _edgeKey(a, b) {
        return a < b ? `${a}:${b}` : `${b}:${a}`;
    }

    _pushOrientedTriangle(faceOut, vertices, a, b, c, refNx, refNy, refNz) {
        const ai = a * 3;
        const bi = b * 3;
        const ci = c * 3;
        const abx = vertices[bi] - vertices[ai];
        const aby = vertices[bi + 1] - vertices[ai + 1];
        const abz = vertices[bi + 2] - vertices[ai + 2];
        const acx = vertices[ci] - vertices[ai];
        const acy = vertices[ci + 1] - vertices[ai + 1];
        const acz = vertices[ci + 2] - vertices[ai + 2];
        const nx = aby * acz - abz * acy;
        const ny = abz * acx - abx * acz;
        const nz = abx * acy - aby * acx;
        const dot = nx * refNx + ny * refNy + nz * refNz;
        if (dot >= 0) {
            faceOut.push(a, b, c);
        } else {
            faceOut.push(a, c, b);
        }
    }

    _relaxVertices(indices, factor = 0.16, iterations = 1) {
        if (!indices || indices.length === 0 || !this.neighbors) return;
        const safeFactor = Math.max(0, Math.min(0.45, factor));
        if (safeFactor <= 0) return;

        const temp = [];
        const vertices = this.vertices;
        for (let iter = 0; iter < iterations; iter++) {
            temp.length = 0;
            for (const idx of indices) {
                if (idx < 0 || idx >= this.vertexCount) continue;
                const neighbors = this.neighbors[idx];
                if (!neighbors || neighbors.length < 3) continue;

                let avgX = 0;
                let avgY = 0;
                let avgZ = 0;
                let count = 0;
                for (const n of neighbors) {
                    if (n < 0 || n >= this.vertexCount) continue;
                    const ni = n * 3;
                    avgX += vertices[ni];
                    avgY += vertices[ni + 1];
                    avgZ += vertices[ni + 2];
                    count++;
                }
                if (count === 0) continue;

                avgX /= count;
                avgY /= count;
                avgZ /= count;

                const i = idx * 3;
                const px = vertices[i];
                const py = vertices[i + 1];
                const pz = vertices[i + 2];

                temp.push({
                    idx,
                    x: px + (avgX - px) * safeFactor,
                    y: py + (avgY - py) * safeFactor,
                    z: pz + (avgZ - pz) * safeFactor
                });
            }

            for (const t of temp) {
                const i = t.idx * 3;
                vertices[i] = t.x;
                vertices[i + 1] = t.y;
                vertices[i + 2] = t.z;
            }
        }
    }

    _splitTriangle(faceOut, vertices, v0, v1, v2, m01, m12, m20, refNx, refNy, refNz) {
        const has01 = m01 >= 0;
        const has12 = m12 >= 0;
        const has20 = m20 >= 0;
        const splitCount = (has01 ? 1 : 0) + (has12 ? 1 : 0) + (has20 ? 1 : 0);

        if (splitCount === 0) {
            this._pushOrientedTriangle(faceOut, vertices, v0, v1, v2, refNx, refNy, refNz);
            return;
        }

        if (splitCount === 1) {
            if (has01) {
                this._pushOrientedTriangle(faceOut, vertices, v0, m01, v2, refNx, refNy, refNz);
                this._pushOrientedTriangle(faceOut, vertices, m01, v1, v2, refNx, refNy, refNz);
                return;
            }
            if (has12) {
                this._pushOrientedTriangle(faceOut, vertices, v0, v1, m12, refNx, refNy, refNz);
                this._pushOrientedTriangle(faceOut, vertices, v0, m12, v2, refNx, refNy, refNz);
                return;
            }
            this._pushOrientedTriangle(faceOut, vertices, v0, v1, m20, refNx, refNy, refNz);
            this._pushOrientedTriangle(faceOut, vertices, m20, v1, v2, refNx, refNy, refNz);
            return;
        }

        if (splitCount === 2) {
            if (has01 && has12) {
                this._pushOrientedTriangle(faceOut, vertices, v0, m01, v2, refNx, refNy, refNz);
                this._pushOrientedTriangle(faceOut, vertices, m01, m12, v2, refNx, refNy, refNz);
                this._pushOrientedTriangle(faceOut, vertices, m01, v1, m12, refNx, refNy, refNz);
                return;
            }
            if (has12 && has20) {
                this._pushOrientedTriangle(faceOut, vertices, v1, m12, v0, refNx, refNy, refNz);
                this._pushOrientedTriangle(faceOut, vertices, m12, m20, v0, refNx, refNy, refNz);
                this._pushOrientedTriangle(faceOut, vertices, m12, v2, m20, refNx, refNy, refNz);
                return;
            }
            this._pushOrientedTriangle(faceOut, vertices, v2, m20, v1, refNx, refNy, refNz);
            this._pushOrientedTriangle(faceOut, vertices, m20, m01, v1, refNx, refNy, refNz);
            this._pushOrientedTriangle(faceOut, vertices, m20, v0, m01, refNx, refNy, refNz);
            return;
        }

        this._pushOrientedTriangle(faceOut, vertices, v0, m01, m20, refNx, refNy, refNz);
        this._pushOrientedTriangle(faceOut, vertices, m01, v1, m12, refNx, refNy, refNz);
        this._pushOrientedTriangle(faceOut, vertices, m20, m12, v2, refNx, refNy, refNz);
        this._pushOrientedTriangle(faceOut, vertices, m01, m12, m20, refNx, refNy, refNz);
    }

    refineRegionForBrush(seedIndices, options = {}) {
        if (!seedIndices || seedIndices.length === 0 || !this.faces || this.faces.length === 0) {
            return { changed: false, addedVertices: 0 };
        }

        const center = options.center || null;
        const radius = Math.max(1e-5, options.radius || 0.0);
        const targetEdgeLength = Math.max(1e-5, options.targetEdgeLength || Math.max(0.012, radius * 0.22));
        const edgeThreshold = Math.max(1.02, options.edgeThreshold || 1.15);
        const maxSplitEdges = Math.max(32, options.maxSplitEdges || 1800);
        const maxAddedVertices = Math.max(64, options.maxAddedVertices || 2200);
        const maxVertexCount = Math.max(2000, options.maxVertexCount || 260000);

        if (this.vertexCount >= maxVertexCount) {
            return { changed: false, addedVertices: 0 };
        }

        const seedScratch = this._nextVertexScratchMark();
        const seedMarks = seedScratch.marks;
        const seedStamp = seedScratch.stamp;
        const markSeed = (idx) => {
            if (idx < 0 || idx >= this.vertexCount) return;
            if (seedMarks[idx] === seedStamp) return;
            seedMarks[idx] = seedStamp;
            const neighbors = this.neighbors?.[idx];
            if (!neighbors) return;
            for (const n of neighbors) {
                if (n >= 0 && n < this.vertexCount) {
                    seedMarks[n] = seedStamp;
                }
            }
        };

        for (const idx of seedIndices) {
            markSeed(idx);
        }

        const vertices = this.vertices;
        const faces = this.faces;
        const radiusLimitSq = (radius * 1.6) * (radius * 1.6);
        const candidateEdges = new Map();

        const maybeCollectEdge = (a, b) => {
            const ai = a * 3;
            const bi = b * 3;
            const dx = vertices[bi] - vertices[ai];
            const dy = vertices[bi + 1] - vertices[ai + 1];
            const dz = vertices[bi + 2] - vertices[ai + 2];
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (len <= targetEdgeLength * edgeThreshold) return;

            if (center && radius > 0) {
                const mx = (vertices[ai] + vertices[bi]) * 0.5 - center[0];
                const my = (vertices[ai + 1] + vertices[bi + 1]) * 0.5 - center[1];
                const mz = (vertices[ai + 2] + vertices[bi + 2]) * 0.5 - center[2];
                if (mx * mx + my * my + mz * mz > radiusLimitSq) return;
            }

            const key = this._edgeKey(a, b);
            const prev = candidateEdges.get(key);
            if (!prev || len > prev.len) {
                const vMin = a < b ? a : b;
                const vMax = a < b ? b : a;
                candidateEdges.set(key, { a: vMin, b: vMax, len });
            }
        };

        const faceScratch = this._nextFaceScratchMark();
        const faceSeen = faceScratch.marks;
        const faceSeenStamp = faceScratch.stamp;
        const incidentFaces = [];
        if (this.vertexFaces && this.vertexFaces.length === this.vertexCount) {
            for (let v = 0; v < this.vertexCount; v++) {
                if (seedMarks[v] !== seedStamp) continue;
                const vf = this.vertexFaces[v];
                if (!vf) continue;
                for (const faceIdx of vf) {
                    if (faceIdx < 0 || faceIdx >= this.faceCount) continue;
                    if (faceSeen[faceIdx] === faceSeenStamp) continue;
                    faceSeen[faceIdx] = faceSeenStamp;
                    incidentFaces.push(faceIdx);
                }
            }
        } else {
            for (let faceIdx = 0; faceIdx < this.faceCount; faceIdx++) {
                const base = faceIdx * 3;
                const v0 = faces[base];
                const v1 = faces[base + 1];
                const v2 = faces[base + 2];
                if (seedMarks[v0] !== seedStamp && seedMarks[v1] !== seedStamp && seedMarks[v2] !== seedStamp) {
                    continue;
                }
                incidentFaces.push(faceIdx);
            }
        }

        for (const faceIdx of incidentFaces) {
            const base = faceIdx * 3;
            const v0 = faces[base];
            const v1 = faces[base + 1];
            const v2 = faces[base + 2];
            maybeCollectEdge(v0, v1);
            maybeCollectEdge(v1, v2);
            maybeCollectEdge(v2, v0);
        }

        if (candidateEdges.size === 0) {
            return { changed: false, addedVertices: 0 };
        }

        // UV/hard-normal seams represent one geometric edge with multiple
        // render edges. Refining only one copy creates an unmatched midpoint
        // that can move independently on later strokes and reopen the seam.
        // Group equivalent edges and admit each group atomically.
        const edgeGroups = new Map();
        const endpointKey = (index) => {
            const groupIndex = this.coincidentGroupByVertex?.[index] ?? -1;
            return groupIndex >= 0 ? `g${groupIndex}` : `v${index}`;
        };
        for (const edge of candidateEdges.values()) {
            const aKey = endpointKey(edge.a);
            const bKey = endpointKey(edge.b);
            const groupKey = aKey < bKey ? `${aKey}:${bKey}` : `${bKey}:${aKey}`;
            let group = edgeGroups.get(groupKey);
            if (!group) {
                group = { len: edge.len, edges: [] };
                edgeGroups.set(groupKey, group);
            }
            group.len = Math.max(group.len, edge.len);
            group.edges.push(edge);
        }
        const sortedEdgeGroups = Array.from(edgeGroups.values()).sort((a, b) => b.len - a.len);
        const remainingBudget = Math.max(0, maxVertexCount - this.vertexCount);
        const splitBudget = Math.min(maxSplitEdges, maxAddedVertices, remainingBudget);
        if (splitBudget <= 0) {
            return { changed: false, addedVertices: 0 };
        }
        const activeEdges = [];
        for (const group of sortedEdgeGroups) {
            if (activeEdges.length + group.edges.length > splitBudget) continue;
            activeEdges.push(...group.edges);
            if (activeEdges.length >= splitBudget) break;
        }
        const splitEdgeMap = new Map();
        for (const edge of activeEdges) {
            splitEdgeMap.set(this._edgeKey(edge.a, edge.b), true);
        }

        if (splitEdgeMap.size === 0) {
            return { changed: false, addedVertices: 0 };
        }

        this.ensureVertexMask();
        const maskVals = Array.from(this.vertexMask);
        const ownerVals = this.vertexOwners ? Array.from(this.vertexOwners) : null;
        const newVertices = Array.from(vertices);
        const midpointIndices = new Map();
        const getMidpointIndex = (a, b) => {
            const key = this._edgeKey(a, b);
            if (!splitEdgeMap.has(key)) return -1;
            const cached = midpointIndices.get(key);
            if (cached !== undefined) return cached;

            const ai = a * 3;
            const bi = b * 3;
            const mx = (newVertices[ai] + newVertices[bi]) * 0.5;
            const my = (newVertices[ai + 1] + newVertices[bi + 1]) * 0.5;
            const mz = (newVertices[ai + 2] + newVertices[bi + 2]) * 0.5;
            const idx = newVertices.length / 3;
            newVertices.push(mx, my, mz);
            const ma = a < maskVals.length ? maskVals[a] : 0;
            const mb = b < maskVals.length ? maskVals[b] : 0;
            let midM = 0.5 * (ma + mb);
            if (midM >= 0.991) {
                midM = 1;
            }
            maskVals.push(midM);
            if (ownerVals) ownerVals.push(ownerVals[a]);
            midpointIndices.set(key, idx);
            return idx;
        };

        const newFaces = [];
        for (let faceIdx = 0; faceIdx < this.faceCount; faceIdx++) {
            const base = faceIdx * 3;
            const v0 = faces[base];
            const v1 = faces[base + 1];
            const v2 = faces[base + 2];
            const i0 = v0 * 3;
            const i1 = v1 * 3;
            const i2 = v2 * 3;

            const e1x = vertices[i1] - vertices[i0];
            const e1y = vertices[i1 + 1] - vertices[i0 + 1];
            const e1z = vertices[i1 + 2] - vertices[i0 + 2];
            const e2x = vertices[i2] - vertices[i0];
            const e2y = vertices[i2 + 1] - vertices[i0 + 1];
            const e2z = vertices[i2 + 2] - vertices[i0 + 2];
            const refNx = e1y * e2z - e1z * e2y;
            const refNy = e1z * e2x - e1x * e2z;
            const refNz = e1x * e2y - e1y * e2x;

            const m01 = getMidpointIndex(v0, v1);
            const m12 = getMidpointIndex(v1, v2);
            const m20 = getMidpointIndex(v2, v0);

            this._splitTriangle(newFaces, newVertices, v0, v1, v2, m01, m12, m20, refNx, refNy, refNz);
        }

        const addedVertices = midpointIndices.size;
        if (addedVertices === 0) {
            return { changed: false, addedVertices: 0 };
        }

        const oldVertexCount = this.vertexCount;
        if (this.uvs && this.uvs.length === oldVertexCount * 2) {
            const oldUvs = this.uvs;
            const newVertexCount = newVertices.length / 3;
            const newUVs = new Float32Array(newVertexCount * 2);
            newUVs.set(oldUvs);
            for (const [edgeKey, midIdx] of midpointIndices) {
                const colonPos = edgeKey.indexOf(':');
                const a = parseInt(edgeKey.slice(0, colonPos), 10);
                const b = parseInt(edgeKey.slice(colonPos + 1), 10);
                newUVs[midIdx * 2]     = (oldUvs[a * 2]     + oldUvs[b * 2])     * 0.5;
                newUVs[midIdx * 2 + 1] = (oldUvs[a * 2 + 1] + oldUvs[b * 2 + 1]) * 0.5;
            }
            this.uvs = newUVs;
        } else {
            this.uvs = null;
        }
        this.vertices = new Float32Array(newVertices);
        this.faces = new Uint32Array(newFaces);
        this.vertexCount = this.vertices.length / 3;
        this.faceCount = this.faces.length / 3;
        this.vertexOwners = ownerVals ? new Uint32Array(ownerVals) : null;
        this._rebuildCoincidentGroups();
        this.vertexMask = new Float32Array(this.vertexCount);
        for (let i = 0; i < Math.min(maskVals.length, this.vertexCount); i++) {
            this.vertexMask[i] = maskVals[i];
        }
        this._resetScratchBuffers();
        this.topologyRevision++;
        this.buildAdjacency();
        const newlyAddedIndices = Array.from(midpointIndices.values());
        this._relaxVertices(newlyAddedIndices, 0.14, 1);
        this.synchronizeCoincidentVertices(newlyAddedIndices);
        this.recalculateNormals();
        this.computeEdgeLengths();
        this.buildVertexFaces();
        this.buildOctree();

        return { changed: true, addedVertices };
    }

    _hasActiveMask() {
        this.ensureVertexMask();
        for (let i = 0; i < this.vertexMask.length; i++) {
            if (this.vertexMask[i] > 1e-6) {
                return true;
            }
        }
        return false;
    }

    /**
     * Serialize for JSON storage
     */
    serialize() {
        const out = {
            vertices: Array.from(this.vertices),
            faces: Array.from(this.faces)
        };
        if (this.uvs && this.uvs.length === this.vertexCount * 2) {
            out.uvs = Array.from(this.uvs);
        }
        if (this.vertexOwners && this.vertexOwners.length === this.vertexCount) {
            out.vertexOwners = Array.from(this.vertexOwners);
        }
        if (this._hasActiveMask()) {
            out.vertexMask = Array.from(this.vertexMask);
        }
        return out;
    }

    /**
     * Typed-array copies of the same payload serialize() would produce.
     * Transferable to a worker so JSON building happens off the main thread.
     */
    serializeBuffers() {
        const out = {
            vertices: this.vertices.slice(),
            faces: this.faces.slice()
        };
        if (this.uvs && this.uvs.length === this.vertexCount * 2) {
            out.uvs = this.uvs.slice();
        }
        if (this.vertexOwners && this.vertexOwners.length === this.vertexCount) {
            out.vertexOwners = this.vertexOwners.slice();
        }
        if (this._hasActiveMask()) {
            out.vertexMask = this.vertexMask.slice();
        }
        return out;
    }
}
