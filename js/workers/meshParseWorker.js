/**
 * Parses OBJ/FBX/glTF off the main thread and returns the geometry as
 * transferable typed arrays. Every failure reply says whether the caller may
 * retry on the main thread and hands the source buffer back when it can.
 */

import {
    parseFBXBuffer,
    parseGLTFData,
    parseOBJData
} from "../mesh/parseMeshThree.bundle.js";

function transferableResult(result) {
    const normalized = {
        ...result,
        vertices: result.vertices instanceof Float32Array
            ? result.vertices
            : new Float32Array(result.vertices || []),
        faces: result.faces instanceof Uint32Array
            ? result.faces
            : new Uint32Array(result.faces || []),
        uvs: result.uvs instanceof Float32Array
            ? result.uvs
            : new Float32Array(result.uvs || []),
        vertexOwners: result.vertexOwners instanceof Uint32Array
            ? result.vertexOwners
            : new Uint32Array(result.vertexOwners || [])
    };
    const transfers = [
        normalized.vertices.buffer,
        normalized.faces.buffer,
        normalized.uvs.buffer,
        normalized.vertexOwners.buffer
    ];
    if (
        typeof ImageBitmap !== "undefined" &&
        normalized.diffuseImage instanceof ImageBitmap
    ) {
        transfers.push(normalized.diffuseImage);
    } else if (normalized.diffuseImage) {
        // The loader decoded the texture into an HTMLImageElement or canvas,
        // neither of which can cross the worker boundary. Signal the caller to
        // redo the parse on the main thread rather than drop the texture.
        return null;
    }
    return { normalized, transfers };
}

self.onmessage = async (event) => {
    const { kind, data, companionFiles } = event.data || {};
    try {
        let result;
        if (kind === "obj") {
            result = await parseOBJData(data, { companionFiles });
        } else if (kind === "fbx") {
            result = await parseFBXBuffer(data, { textureFiles: companionFiles });
        } else if (kind === "gltf") {
            result = await parseGLTFData(data, { companionFiles });
        } else {
            throw new Error("unsupported mesh parser kind");
        }
        const transferable = transferableResult(result);
        if (!transferable) {
            // Transfer the source buffer back so the main-thread retry still has
            // it; the caller lost ownership when it posted the job in.
            self.postMessage({
                ok: false,
                error: "parsed texture requires main-thread decode",
                fallbackAllowed: true,
                returnedData: data
            }, data instanceof ArrayBuffer ? [data] : []);
            return;
        }
        self.postMessage(
            { ok: true, result: transferable.normalized },
            transferable.transfers
        );
    } catch (error) {
        const message = error?.message || String(error);
        // Loaders that reach for the DOM fail in a recognizable way here; those
        // are the only failures worth retrying on the main thread.
        const domRequired =
            error instanceof ReferenceError ||
            /document|HTMLImageElement|createElementNS/i.test(message);
        self.postMessage({
            ok: false,
            error: message,
            fallbackAllowed: domRequired,
            returnedData: data
        }, data instanceof ArrayBuffer ? [data] : []);
    }
};
