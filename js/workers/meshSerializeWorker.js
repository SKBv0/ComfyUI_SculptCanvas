/**
 * Off-main-thread mesh serialization + hashing.
 *
 * Receives transferable typed arrays, builds the exact JSON payload
 * Mesh.serialize() would produce, and computes its SHA-256 (the server-side
 * content address). Keeps multi-hundred-millisecond stringify work off the UI
 * thread for dense meshes.
 */

self.onmessage = (e) => {
    const { id, vertices, faces, uvs, vertexOwners, vertexMask } = e.data || {};
    const run = async () => {
        try {
            const payload = {
                schemaVersion: 5,
                vertices: Array.from(vertices),
                faces: Array.from(faces)
            };
            if (uvs) {
                payload.uvs = Array.from(uvs);
            }
            if (vertexOwners) {
                payload.vertexOwners = Array.from(vertexOwners);
            }
            if (vertexMask) {
                payload.vertexMask = Array.from(vertexMask);
            }
            const body = JSON.stringify(payload);
            let hex = null;
            if (self.crypto && self.crypto.subtle) {
                const digest = await self.crypto.subtle.digest(
                    "SHA-256",
                    new TextEncoder().encode(body)
                );
                hex = Array.from(new Uint8Array(digest))
                    .map((b) => b.toString(16).padStart(2, "0"))
                    .join("");
            }
            self.postMessage({ id, body, hex });
        } catch (err) {
            self.postMessage({ id, error: String(err && err.message ? err.message : err) });
        }
    };
    run();
};
