/**
 * Brush operations for sculpting.
 */

/**
 * Two-ring brush falloff: full strength inside innerRadius, smoothstep decay
 * from there out to outerRadius, zero beyond.
 * @param {number} distance - Distance from brush center
 * @param {number} innerRadius - Radius of full-strength inner zone
 * @param {number} outerRadius - Total brush radius
 */
function twoRingFalloff(distance, innerRadius, outerRadius) {
    if (distance <= innerRadius) {
        return 1.0;
    }
    if (distance >= outerRadius) {
        return 0.0;
    }
    const t = (distance - innerRadius) / (outerRadius - innerRadius);
    return 1 - t * t * (3 - 2 * t);
}

function clamp01(v) {
    return Math.max(0, Math.min(1, v));
}

function normalize3(v) {
    const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    if (len < 1e-8) return [0, 0, 0];
    return [v[0] / len, v[1] / len, v[2] / len];
}

function shapeStrength(strength, power = 1.18) {
    const safe = Math.max(0, Math.min(2.0, strength));
    if (safe <= 1.0) {
        return Math.pow(safe, power);
    }
    const boosted = 1.0 + Math.pow(safe - 1.0, Math.max(1.05, power * 1.15)) * 1.35;
    return Math.min(2.75, boosted);
}

function gaussianFalloff01(t, sigma = 0.5) {
    const safeT = clamp01(t);
    const safeSigma = Math.max(0.05, sigma);
    const inv = 1 / (2 * safeSigma * safeSigma);
    return Math.exp(-(safeT * safeT) * inv);
}

function clampVectorByLocalScale(mesh, index, vx, vy, vz, falloff, limitFactor = 0.35) {
    const len = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (len < 1e-9) return [vx, vy, vz];

    const edgeScale = mesh.getEdgeScale ? mesh.getEdgeScale(index) : 0.02;
    const maxLen = Math.max(0.00035, edgeScale * limitFactor * (0.4 + 0.6 * falloff));
    if (len <= maxLen) return [vx, vy, vz];

    const s = maxLen / len;
    return [vx * s, vy * s, vz * s];
}

function getBrushScratch(mesh) {
    const vertexCount = mesh.vertexCount || 0;
    const current = mesh._brushScratch;
    if (
        current
        && current.size === vertexCount
        && current.candidateMarks
        && current.visitedMarks
        && current.affectedMarks
        && current.affectedFalloff
    ) {
        return current;
    }

    const scratch = {
        size: vertexCount,
        stamp: 0,
        candidateMarks: new Int32Array(vertexCount),
        visitedMarks: new Int32Array(vertexCount),
        affectedMarks: new Int32Array(vertexCount),
        affectedFalloff: new Float32Array(vertexCount),
        affectedIndices: []
    };
    mesh._brushScratch = scratch;
    return scratch;
}

function nextScratchStamp(scratch) {
    scratch.stamp++;
    if (scratch.stamp <= 0) {
        scratch.candidateMarks.fill(0);
        scratch.visitedMarks.fill(0);
        scratch.affectedMarks.fill(0);
        scratch.stamp = 1;
    }
    return scratch.stamp;
}

/**
 * Lightweight relaxation pass to reduce spikes after brush displacement.
 */
function relaxAffectedVertices(mesh, affectedVertices, amount) {
    if (!mesh.neighbors || !affectedVertices || affectedVertices.length === 0) return;
    if (amount <= 0) return;

    mesh.ensureVertexMask();
    const vm = mesh.vertexMask;
    const vertices = mesh.vertices;
    const targets = [];
    for (const { index, falloff } of affectedVertices) {
        const neighbors = mesh.neighbors[index];
        if (!neighbors || neighbors.length === 0) continue;

        const mi = index >= 0 && index < vm.length ? vm[index] : 0;
        const maskFree = Math.max(0, Math.min(1, 1 - mi));
        const maskRelax = maskFree * maskFree;

        let avgX = 0;
        let avgY = 0;
        let avgZ = 0;
        let count = 0;
        for (const n of neighbors) {
            if (n < 0 || n >= mesh.vertexCount) continue;
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

        const i = index * 3;
        const px = vertices[i];
        const py = vertices[i + 1];
        const pz = vertices[i + 2];
        const relax = amount * falloff * maskRelax;
        targets.push({
            index,
            x: px + (avgX - px) * relax,
            y: py + (avgY - py) * relax,
            z: pz + (avgZ - pz) * relax
        });
    }

    for (const t of targets) {
        mesh.setVertex(t.index, t.x, t.y, t.z);
    }
}


/**
 * Standard brush - push/pull vertices along normals
 */
export function applyStandardBrush(mesh, affectedVertices, strength, invert = false, context = {}) {
    const direction = invert ? -1 : 1;
    const radius = context.radius || 0.15;
    const hitNormal = context.hitNormal ? normalize3(context.hitNormal) : null;
    const baseDisplacement = 0.0036 + radius * 0.0065;
    const safeStrength = shapeStrength(strength, 1.22);
    const vertices = mesh.vertices;
    const normals = mesh.normals;

    for (const { index, falloff } of affectedVertices) {
        const i = index * 3;
        const nx0 = normals[i];
        const ny0 = normals[i + 1];
        const nz0 = normals[i + 2];
        if (nx0 === 0 && ny0 === 0 && nz0 === 0) continue;

        let nx = nx0;
        let ny = ny0;
        let nz = nz0;
        if (hitNormal && (hitNormal[0] || hitNormal[1] || hitNormal[2])) {
            // Favor stroke normal for stable clay buildup and less tearing.
            let bx = hitNormal[0] * 0.78 + nx * 0.22;
            let by = hitNormal[1] * 0.78 + ny * 0.22;
            let bz = hitNormal[2] * 0.78 + nz * 0.22;
            const bLen = Math.sqrt(bx * bx + by * by + bz * bz);
            if (bLen > 1e-8) {
                const invBLen = 1 / bLen;
                bx *= invBLen;
                by *= invBLen;
                bz *= invBLen;
                nx = bx;
                ny = by;
                nz = bz;
            }
        }

        const displacement = safeStrength * falloff * direction * baseDisplacement;
        const [dx, dy, dz] = clampVectorByLocalScale(
            mesh,
            index,
            nx * displacement,
            ny * displacement,
            nz * displacement,
            falloff,
            0.34
        );

        mesh.setVertex(
            index,
            vertices[i] + dx,
            vertices[i + 1] + dy,
            vertices[i + 2] + dz
        );
    }

    // Gentle post-relax keeps surface cohesive without killing detail.
    relaxAffectedVertices(mesh, affectedVertices, 0.045 * safeStrength);
}

/**
 * Smooth brush - average neighbor positions (Laplacian smoothing).
 * Invert: negative blend pulls away from neighbor average (light sharpening).
 */
export function applySmoothBrush(mesh, affectedVertices, strength, invert = false) {
    const safeStrength = shapeStrength(strength, 0.95);
    const vertices = mesh.vertices;
    const dir = invert ? -1 : 1;
    const targets = [];

    for (const { index, falloff } of affectedVertices) {
        const neighbors = mesh.neighbors?.[index];
        if (!neighbors || neighbors.length === 0) continue;

        let avgX = 0, avgY = 0, avgZ = 0;
        let validNeighbors = 0;

        for (const neighborIdx of neighbors) {
            if (neighborIdx >= mesh.vertexCount) continue;
            const ni = neighborIdx * 3;
            avgX += vertices[ni];
            avgY += vertices[ni + 1];
            avgZ += vertices[ni + 2];
            validNeighbors++;
        }

        if (validNeighbors === 0) continue;

        avgX /= validNeighbors;
        avgY /= validNeighbors;
        avgZ /= validNeighbors;

        const i = index * 3;
        const px = vertices[i];
        const py = vertices[i + 1];
        const pz = vertices[i + 2];
        const factor = safeStrength * falloff * 0.32 * dir;

        let mx = (avgX - px) * factor;
        let my = (avgY - py) * factor;
        let mz = (avgZ - pz) * factor;
        if (invert) {
            // Sharpen amplifies deviation from the neighbor average; without a
            // cap each dab multiplies the deviation and a held stroke diverges
            // into exponential spikes. Smoothing itself is contractive and
            // needs no clamp.
            [mx, my, mz] = clampVectorByLocalScale(mesh, index, mx, my, mz, falloff, 0.3);
        }

        targets.push({
            index,
            x: px + mx,
            y: py + my,
            z: pz + mz
        });
    }

    // Write only after every target is computed, so all neighbor averages
    // above read the same pre-pass positions.
    for (const target of targets) {
        mesh.setVertex(target.index, target.x, target.y, target.z);
    }
}

/**
 * Inflate brush - uniform outward expansion
 * Unlike Standard brush, Inflate creates smooth balloon-like expansion
 * by blending vertex normal with outward direction from region center
 */
export function applyInflateBrush(mesh, affectedVertices, strength, invert = false, context = {}) {
    if (affectedVertices.length === 0) return;

    const direction = invert ? -1 : 1;
    const radius = context.radius || 0.15;
    const safeStrength = shapeStrength(strength, 1.15);
    const baseDisplacement = 0.0038 + radius * 0.0075;
    const vertices = mesh.vertices;
    const normals = mesh.normals;

    let centerX = 0, centerY = 0, centerZ = 0;
    let weightSum = 0;

    for (const { index, falloff } of affectedVertices) {
        const i = index * 3;
        centerX += vertices[i] * falloff;
        centerY += vertices[i + 1] * falloff;
        centerZ += vertices[i + 2] * falloff;
        weightSum += falloff;
    }

    if (weightSum === 0) return;

    centerX /= weightSum;
    centerY /= weightSum;
    centerZ /= weightSum;

    const hp = context.hitPoint;
    if (hp && hp.length >= 3 && Number.isFinite(hp[0]) && Number.isFinite(hp[1]) && Number.isFinite(hp[2])) {
        const t = 0.52;
        centerX = hp[0] * t + centerX * (1 - t);
        centerY = hp[1] * t + centerY * (1 - t);
        centerZ = hp[2] * t + centerZ * (1 - t);
    }

    for (const { index, falloff } of affectedVertices) {
        const i = index * 3;
        const normalX = normals[i];
        const normalY = normals[i + 1];
        const normalZ = normals[i + 2];
        if (normalX === 0 && normalY === 0 && normalZ === 0) continue;

        let outX = vertices[i] - centerX;
        let outY = vertices[i + 1] - centerY;
        let outZ = vertices[i + 2] - centerZ;

        const outLen = Math.sqrt(outX * outX + outY * outY + outZ * outZ);
        if (outLen > 0.0001) {
            outX /= outLen;
            outY /= outLen;
            outZ /= outLen;
        } else {
            // A vertex sitting on the region center has no outward direction.
            outX = normalX;
            outY = normalY;
            outZ = normalZ;
        }

        // Blend: mostly normal to avoid tearing on dense meshes.
        const blendX = normalX * 0.8 + outX * 0.2;
        const blendY = normalY * 0.8 + outY * 0.2;
        const blendZ = normalZ * 0.8 + outZ * 0.2;

        const displacement = safeStrength * falloff * direction * baseDisplacement;
        const [dx, dy, dz] = clampVectorByLocalScale(
            mesh,
            index,
            blendX * displacement,
            blendY * displacement,
            blendZ * displacement,
            falloff,
            0.36
        );

        mesh.setVertex(
            index,
            vertices[i] + dx,
            vertices[i + 1] + dy,
            vertices[i + 2] + dz
        );
    }

    relaxAffectedVertices(mesh, affectedVertices, 0.04 * safeStrength);
}

/**
 * Flatten brush - flatten vertices towards average plane.
 * Invert: displaces away from the plane (relief) instead of toward it.
 */
export function applyFlattenBrush(mesh, affectedVertices, strength, context = {}, invert = false) {
    if (affectedVertices.length === 0) return;
    const safeStrength = shapeStrength(strength, 1.05);
    const hitNormal = context.hitNormal ? normalize3(context.hitNormal) : null;
    const vertices = mesh.vertices;
    const normals = mesh.normals;

    // Falloff-weighted average position and normal define the target plane.
    let centerX = 0, centerY = 0, centerZ = 0;
    let normX = 0, normY = 0, normZ = 0;
    let weightSum = 0;

    for (const { index, falloff } of affectedVertices) {
        const i = index * 3;

        centerX += vertices[i] * falloff;
        centerY += vertices[i + 1] * falloff;
        centerZ += vertices[i + 2] * falloff;

        normX += normals[i] * falloff;
        normY += normals[i + 1] * falloff;
        normZ += normals[i + 2] * falloff;

        weightSum += falloff;
    }

    if (weightSum === 0) return;

    centerX /= weightSum;
    centerY /= weightSum;
    centerZ /= weightSum;

    const len = Math.sqrt(normX * normX + normY * normY + normZ * normZ);
    if (len > 0) {
        normX /= len;
        normY /= len;
        normZ /= len;
    }

    if (hitNormal && (hitNormal[0] || hitNormal[1] || hitNormal[2])) {
        let bx = normX * 0.4 + hitNormal[0] * 0.6;
        let by = normY * 0.4 + hitNormal[1] * 0.6;
        let bz = normZ * 0.4 + hitNormal[2] * 0.6;
        const bLen = Math.sqrt(bx * bx + by * by + bz * bz);
        if (bLen > 1e-8) {
            const invBLen = 1 / bLen;
            bx *= invBLen;
            by *= invBLen;
            bz *= invBLen;
            normX = bx;
            normY = by;
            normZ = bz;
        }
    }

    for (const { index, falloff } of affectedVertices) {
        const i = index * 3;
        const px = vertices[i];
        const py = vertices[i + 1];
        const pz = vertices[i + 2];

        const fromCenterX = px - centerX;
        const fromCenterY = py - centerY;
        const fromCenterZ = pz - centerZ;

        // Signed distance to the plane, then the projection of the vertex onto it.
        const distToPlane = fromCenterX * normX + fromCenterY * normY + fromCenterZ * normZ;

        const targetX = px - normX * distToPlane;
        const targetY = py - normY * distToPlane;
        const targetZ = pz - normZ * distToPlane;

        const factor = safeStrength * falloff * 0.35;
        let mx = (targetX - px) * factor;
        let my = (targetY - py) * factor;
        let mz = (targetZ - pz) * factor;
        if (invert) {
            mx = -mx;
            my = -my;
            mz = -mz;
        }

        const [dx, dy, dz] = clampVectorByLocalScale(
            mesh,
            index,
            mx,
            my,
            mz,
            falloff,
            0.48
        );

        mesh.setVertex(index, px + dx, py + dy, pz + dz);
    }

    relaxAffectedVertices(mesh, affectedVertices, 0.025 * safeStrength);
}

/**
 * Pinch brush - pull vertices towards center
 */
export function applyPinchBrush(mesh, affectedVertices, strength, invert = false, context = {}) {
    if (affectedVertices.length === 0) return;
    const vertices = mesh.vertices;

    // Hit point center is less jumpy than a moving weighted center.
    let centerX = context.hitPoint ? context.hitPoint[0] : 0;
    let centerY = context.hitPoint ? context.hitPoint[1] : 0;
    let centerZ = context.hitPoint ? context.hitPoint[2] : 0;

    if (!context.hitPoint) {
        let weightSum = 0;
        for (const { index, falloff } of affectedVertices) {
            const i = index * 3;
            centerX += vertices[i] * falloff;
            centerY += vertices[i + 1] * falloff;
            centerZ += vertices[i + 2] * falloff;
            weightSum += falloff;
        }
        if (weightSum === 0) return;
        centerX /= weightSum;
        centerY /= weightSum;
        centerZ /= weightSum;
    }

    const direction = invert ? -1 : 1;
    const safeStrength = shapeStrength(strength, 1.18);
    const factor = safeStrength * 0.11 * direction;
    const hitNormal = context.hitNormal ? normalize3(context.hitNormal) : null;

    for (const { index, falloff } of affectedVertices) {
        const i = index * 3;
        const px = vertices[i];
        const py = vertices[i + 1];
        const pz = vertices[i + 2];

        let towardX = centerX - px;
        let towardY = centerY - py;
        let towardZ = centerZ - pz;
        if (hitNormal && (hitNormal[0] || hitNormal[1] || hitNormal[2])) {
            // Pinch contracts within the tangent plane around the brush axis.
            // Pulling the full 3D chord toward the hit point instead drives
            // curved meshes through themselves and produces long inverted
            // triangles after repeated strong dabs.
            const axial = towardX * hitNormal[0] + towardY * hitNormal[1] + towardZ * hitNormal[2];
            towardX -= hitNormal[0] * axial;
            towardY -= hitNormal[1] * axial;
            towardZ -= hitNormal[2] * axial;
        }

        const [dx, dy, dz] = clampVectorByLocalScale(
            mesh,
            index,
            towardX * falloff * factor,
            towardY * falloff * factor,
            towardZ * falloff * factor,
            falloff,
            0.5
        );
        mesh.setVertex(index, px + dx, py + dy, pz + dz);
    }

    relaxAffectedVertices(mesh, affectedVertices, 0.02 * safeStrength);
}

/**
 * Crease brush - Pinch + Inverted Standard (Push down)
 */
export function applyCreaseBrush(mesh, affectedVertices, strength, invert = false, context = {}) {
    const safeStrength = shapeStrength(strength, 1.2);
    const radius = context.radius || 0.15;
    const vertices = mesh.vertices;
    const normals = mesh.normals;

    // applyPinchBrush shapes strength itself, so hand it the unshaped value.
    // Shaping twice compounds the curve and weakens the pinch component of the
    // crease at low strengths.
    applyPinchBrush(mesh, affectedVertices, Math.min(1, strength * 0.95), invert, context);

    const pinchIndices = affectedVertices.map((a) => a.index);
    if (mesh.vertexFaces && mesh.vertexFaces.length) {
        mesh.recalculateNormalsPartial(pinchIndices);
    } else {
        mesh.recalculateNormals();
    }

    const creaseDir = invert ? 1 : -1;
    const hitN = context.hitNormal ? normalize3(context.hitNormal) : null;

    for (const { index, falloff } of affectedVertices) {
        const i = index * 3;
        const nx0 = normals[i];
        const ny0 = normals[i + 1];
        const nz0 = normals[i + 2];
        if (nx0 === 0 && ny0 === 0 && nz0 === 0) continue;

        const sharpFalloff = falloff * falloff;
        let nx = nx0;
        let ny = ny0;
        let nz = nz0;
        if (hitN && (hitN[0] || hitN[1] || hitN[2])) {
            nx = nx0 * 0.45 + hitN[0] * 0.55;
            ny = ny0 * 0.45 + hitN[1] * 0.55;
            nz = nz0 * 0.45 + hitN[2] * 0.55;
            const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
            if (nLen > 1e-8) {
                const invNLen = 1 / nLen;
                nx *= invNLen;
                ny *= invNLen;
                nz *= invNLen;
            } else {
                nx = nx0;
                ny = ny0;
                nz = nz0;
            }
        }
        const displacement = safeStrength * sharpFalloff * creaseDir * (0.0028 + radius * 0.0045);
        const [dx, dy, dz] = clampVectorByLocalScale(
            mesh,
            index,
            nx * displacement,
            ny * displacement,
            nz * displacement,
            falloff,
            0.32
        );

        mesh.setVertex(
            index,
            vertices[i] + dx,
            vertices[i + 1] + dy,
            vertices[i + 2] + dz
        );
    }

    relaxAffectedVertices(mesh, affectedVertices, 0.03 * safeStrength);
}

/**
 * Find vertices affected by brush at a given hit point
 * Uses two-ring falloff for brush control
 *
 * @param {Mesh} mesh - The mesh object
 * @param {Array} hitPoint - [x, y, z] hit position
 * @param {number} radius - Outer brush radius
 * @param {number} innerRatio - Inner radius ratio (0.0-1.0), default 0.4
 * @returns {Array} Array of {index, falloff} objects (with duplicates handled)
 */
export function getAffectedVertices(mesh, hitPoint, radius, innerRatio = 0.4) {
    if (!hitPoint || !mesh.vertices || mesh.vertexCount === 0) {
        return [];
    }

    const innerRadius = radius * innerRatio;
    const radiusSq = radius * radius;
    const scratch = getBrushScratch(mesh);
    const affectedIndices = scratch.affectedIndices;
    affectedIndices.length = 0;
    const affectedStamp = nextScratchStamp(scratch);
    const candidateMarks = scratch.candidateMarks;
    const visitedMarks = scratch.visitedMarks;
    const affectedMarks = scratch.affectedMarks;
    const affectedFalloff = scratch.affectedFalloff;

    const collect = (hx, hy, hz) => {
        const candidateIndices = typeof mesh.queryVerticesInRadius === "function"
            ? mesh.queryVerticesInRadius(hx, hy, hz, radius)
            : null;

        const candidateStamp = nextScratchStamp(scratch);
        const visitedStamp = nextScratchStamp(scratch);
        let seed = -1;
        let seedDistSq = Infinity;

        const considerIndex = (i) => {
            const idx = i * 3;
            const dx = mesh.vertices[idx] - hx;
            const dy = mesh.vertices[idx + 1] - hy;
            const dz = mesh.vertices[idx + 2] - hz;
            const distSq = dx * dx + dy * dy + dz * dz;

            if (distSq < radiusSq) {
                candidateMarks[i] = candidateStamp;
                if (distSq < seedDistSq) {
                    seedDistSq = distSq;
                    seed = i;
                }
            }
        };

        if (candidateIndices !== null) {
            for (const i of candidateIndices) {
                considerIndex(i);
            }
        } else {
            for (let i = 0; i < mesh.vertexCount; i++) {
                considerIndex(i);
            }
        }

        if (seed === -1) return;

        // Keep the connected component around brush center only.
        // Prevents accidental edits on nearby but disconnected folds.
        const stack = [seed];
        visitedMarks[seed] = visitedStamp;

        while (stack.length > 0) {
            const v = stack.pop();
            const idx = v * 3;
            const dx = mesh.vertices[idx] - hx;
            const dy = mesh.vertices[idx + 1] - hy;
            const dz = mesh.vertices[idx + 2] - hz;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const falloff = twoRingFalloff(dist, innerRadius, radius);
            if (falloff <= 0) continue;

            if (affectedMarks[v] !== affectedStamp) {
                affectedMarks[v] = affectedStamp;
                affectedFalloff[v] = falloff;
                affectedIndices.push(v);
            } else if (falloff > affectedFalloff[v]) {
                affectedFalloff[v] = falloff;
            }

            const neighbors = mesh.neighbors?.[v];
            if (!neighbors || neighbors.length === 0) continue;

            for (const n of neighbors) {
                if (candidateMarks[n] !== candidateStamp || visitedMarks[n] === visitedStamp) continue;
                visitedMarks[n] = visitedStamp;
                stack.push(n);
            }
        }
    };

    collect(hitPoint[0], hitPoint[1], hitPoint[2]);

    const results = [];
    for (const index of affectedIndices) {
        results.push({ index, falloff: affectedFalloff[index] });
    }

    return results;
}

/**
 * Clay brush - additive buildup with a flattened profile
 * Similar to ZBrush Clay/ClayBuildup. Grows surface towards a target layer height.
 */
export function applyClayBrush(mesh, affectedVertices, strength, invert = false, context = {}) {
    const direction = invert ? -1 : 1;
    const radius = context.radius || 0.15;
    const strokeContext = context.strokeContext || {};
    const pressure = clamp01(strokeContext.pressure ?? 1.0);
    const pressureGain = 0.55 + pressure * 0.65;
    let safeStrength = shapeStrength(strength, 0.9) * pressureGain;
    const vertices = mesh.vertices;
    const hitPoint = context.hitPoint || [0, 0, 0];
    const hitNormal = context.hitNormal ? normalize3(context.hitNormal) : null;
    if (!hitNormal || (hitNormal[0] === 0 && hitNormal[1] === 0 && hitNormal[2] === 0)) return;

    const stroke = context.clayStroke || null;
    const planeOrigin = stroke?.planeOrigin || hitPoint;
    let nx = hitNormal[0];
    let ny = hitNormal[1];
    let nz = hitNormal[2];
    if (stroke?.planeNormal) {
        let sx = stroke.planeNormal[0];
        let sy = stroke.planeNormal[1];
        let sz = stroke.planeNormal[2];
        if (sx * nx + sy * ny + sz * nz < 0) {
            sx = -sx;
            sy = -sy;
            sz = -sz;
        }
        const blend = 0.72;
        nx = sx * blend + nx * (1 - blend);
        ny = sy * blend + ny * (1 - blend);
        nz = sz * blend + nz * (1 - blend);
    }
    const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nLen < 1e-8) return;
    const invNLen = 1 / nLen;
    nx *= invNLen;
    ny *= invNLen;
    nz *= invNLen;

    const safeRadius = Math.max(1e-5, radius);
    // Depth and step scale linearly with strength, with no constant offset, so
    // a near-zero strength deposits nothing and the slider spans the same
    // dynamic range as the other brushes. The multipliers calibrate strength
    // 1.0 at full pressure to the intended default deposit depth.
    const baseDepth = (0.0032 + safeRadius * 0.0102) * (safeStrength * 1.8667);
    const spacingWorld = Number.isFinite(strokeContext.spacingWorld) ? Math.max(0, strokeContext.spacingWorld) : 0;
    const spacingFactor = 1.0 + clamp01(spacingWorld / Math.max(1e-5, safeRadius * 0.35)) * 0.08;
    const maxStep = (0.0014 + safeRadius * 0.0048) * (safeStrength * 1.84) * spacingFactor;
    const activeVertices = [];

    for (const { index, falloff } of affectedVertices) {
        const i = index * 3;
        const px = vertices[i];
        const py = vertices[i + 1];
        const pz = vertices[i + 2];

        const dxHit = px - hitPoint[0];
        const dyHit = py - hitPoint[1];
        const dzHit = pz - hitPoint[2];
        const radial = Math.sqrt(dxHit * dxHit + dyHit * dyHit + dzHit * dzHit) / safeRadius;
        if (radial > 1.08) continue;

        const gaussian = gaussianFalloff01(radial, 0.46);
        const ring = falloff * 0.34 + gaussian * 0.66;
        const profile = Math.max(0, ring * (1.0 - radial * 0.22));
        if (profile <= 1e-4) continue;

        // Signed distance to stroke plane at hit point.
        const relX = px - planeOrigin[0];
        const relY = py - planeOrigin[1];
        const relZ = pz - planeOrigin[2];
        const signed = relX * nx + relY * ny + relZ * nz;
        const desired = direction * baseDepth * profile;
        let corr = desired - signed;

        // Clay should mostly accumulate in one direction but keep a small return force to avoid terracing.
        if (direction > 0 && corr < 0) corr *= 0.18;
        if (direction < 0 && corr > 0) corr *= 0.18;

        // Stable cap prevents sudden spikes.
        const capped = Math.max(-maxStep, Math.min(maxStep, corr));
        const [dx, dy, dz] = clampVectorByLocalScale(mesh, index, nx * capped, ny * capped, nz * capped, profile, 0.28);
        mesh.setVertex(index, px + dx, py + dy, pz + dz);
        activeVertices.push({ index, falloff: profile });
    }

    // Mild post smoothing to remove stair-stepping while preserving clay mass.
    relaxAffectedVertices(mesh, activeVertices, 0.075 * safeStrength);
}

/**
 * Move brush - grab and drag a region of the mesh
 * Follows mouse delta projected into world space
 */
export function applyMoveBrush(mesh, affectedVertices, strength, delta = [0, 0, 0]) {
    if (affectedVertices.length === 0) return;

    const safeStrength = shapeStrength(strength, 0.9);
    const vertices = mesh.vertices;

    for (const { index, falloff } of affectedVertices) {
        const i = index * 3;

        mesh.setVertex(
            index,
            vertices[i] + delta[0] * falloff * safeStrength,
            vertices[i + 1] + delta[1] * falloff * safeStrength,
            vertices[i + 2] + delta[2] * falloff * safeStrength
        );
    }

    relaxAffectedVertices(mesh, affectedVertices, 0.028 * safeStrength);
}

/**
 * Vertex mask paint: 0 = editable, 1 = fully protected (ZBrush-style).
 */
export function applyMaskBrush(mesh, affectedVertices, strength, subtract = false) {
    if (!affectedVertices || affectedVertices.length === 0) return;
    mesh.ensureVertexMask();
    const rate = 0.22 * shapeStrength(strength, 1.05);
    for (const { index, falloff } of affectedVertices) {
        if (index < 0 || index >= mesh.vertexCount) continue;
        const t = Math.max(0, Math.min(1, rate * falloff));
        let m = mesh.vertexMask[index];
        if (subtract) {
            m *= 1 - t;
        } else {
            m += (1 - m) * t;
        }
        m = Math.max(0, Math.min(1, m));
        if (!subtract && m >= 0.992) {
            m = 1;
        }
        if (subtract && m <= 0.008) {
            m = 0; // symmetric snap: fully unmasked instead of a lingering residue
        }
        mesh.vertexMask[index] = m;
    }
}

/**
 * Trim toward a plane through hit point along hit normal (invert flips plane side).
 */
export function applyTrimBrush(mesh, affectedVertices, strength, invert = false, context = {}) {
    if (!affectedVertices || affectedVertices.length === 0) return;
    const hp = context.hitPoint || [0, 0, 0];
    let n = context.hitNormal ? normalize3(context.hitNormal) : [0, 1, 0];
    if (invert) {
        n = [-n[0], -n[1], -n[2]];
    }
    const [nx, ny, nz] = n;
    const vertices = mesh.vertices;
    const safeStrength = shapeStrength(strength, 1.12);
    const rad = context.radius || 0.15;
    const amt = (0.042 + rad * 0.09) * safeStrength;
    for (const { index, falloff } of affectedVertices) {
        const i = index * 3;
        const vx = vertices[i];
        const vy = vertices[i + 1];
        const vz = vertices[i + 2];
        const ddx = vx - hp[0];
        const ddy = vy - hp[1];
        const ddz = vz - hp[2];
        const dist = ddx * nx + ddy * ny + ddz * nz;
        if (dist > 1e-5) {
            const pull = Math.min(dist, amt * falloff);
            mesh.setVertex(index, vx - nx * pull, vy - ny * pull, vz - nz * pull);
        }
    }
    relaxAffectedVertices(mesh, affectedVertices, 0.035 * safeStrength);
}

/**
 * Brush types
 */
export const BRUSH_TYPES = {
    STANDARD: "standard",
    SMOOTH: "smooth",
    INFLATE: "inflate",
    FLATTEN: "flatten",
    PINCH: "pinch",
    CREASE: "crease",
    CLAY: "clay",
    MOVE: "move",
    TRIM: "trim",
    SNAKE_HOOK: "snake_hook"
};

/**
 * Apply brush based on type
 */
export function applyBrush(type, mesh, affectedVertices, strength, invert = false, context = {}) {
    if (!affectedVertices || affectedVertices.length === 0) return;

    switch (type) {
        case BRUSH_TYPES.STANDARD:
            applyStandardBrush(mesh, affectedVertices, strength, invert, context);
            break;
        case BRUSH_TYPES.SMOOTH:
            applySmoothBrush(mesh, affectedVertices, strength, invert);
            break;
        case BRUSH_TYPES.INFLATE:
            applyInflateBrush(mesh, affectedVertices, strength, invert, context);
            break;
        case BRUSH_TYPES.FLATTEN:
            applyFlattenBrush(mesh, affectedVertices, strength, context, invert);
            break;
        case BRUSH_TYPES.PINCH:
            applyPinchBrush(mesh, affectedVertices, strength, invert, context);
            break;
        case BRUSH_TYPES.CREASE:
            applyCreaseBrush(mesh, affectedVertices, strength, invert, context);
            break;
        case BRUSH_TYPES.CLAY:
            applyClayBrush(mesh, affectedVertices, strength, invert, context);
            break;
        case BRUSH_TYPES.MOVE:
            applyMoveBrush(mesh, affectedVertices, strength, context.moveDelta || [0, 0, 0]);
            break;
        case BRUSH_TYPES.TRIM:
            applyTrimBrush(mesh, affectedVertices, strength, invert, context);
            break;
        case BRUSH_TYPES.SNAKE_HOOK:
            applyMoveBrush(mesh, affectedVertices, strength, context.moveDelta || [0, 0, 0]);
            break;
    }
}
