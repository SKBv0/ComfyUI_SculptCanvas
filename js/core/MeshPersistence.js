/**
 * MeshPersistence - server-side persistence state machine for large meshes.
 *
 * Meshes above the workflow-embed limit are stored content-addressed on the
 * ComfyUI server (`POST /sculpt/mesh`, ref = SHA-256 of the JSON body); the
 * workflow stub embeds only `_meshRef`. This module owns the whole lifecycle:
 *
 * - upload scheduling (immediate while no ref exists, debounced afterwards)
 * - change detection via the engine's geometryRevision (unchanged geometry
 *   never pays serialize/hash/upload costs)
 * - content-hash short-circuit (identical bytes never re-POST)
 * - restore from a ref with stale-response/generation guards
 * - the widget-sync freeze that protects the stub while a restore is pending
 * - a per-instance session lease (`X-Sculpt-Session`) that tells the server
 *   which stored meshes are still in use; `destroy()` releases it
 *
 * All I/O is injected (fetchApi, engine access, apply/resync callbacks) so the
 * state machine is unit-testable without a browser or a ComfyUI server.
 */

import { MAX_MESH_FACE_INDICES, MAX_SCULPT_DATA_BYTES } from "../engine/limits.js";

export const MESH_REQUEST_TIMEOUT_MS = 60000;
export const MESH_WORKER_TIMEOUT_MS = 15000;
export const MESH_REF_PATTERN = /^[0-9a-f]{16,64}$/;
export const MESH_UPLOAD_DEBOUNCE_MS = 300;

function createSessionId() {
    if (typeof globalThis.crypto?.randomUUID === "function") {
        return globalThis.crypto.randomUUID().replaceAll("-", "");
    }
    const bytes = new Uint8Array(16);
    if (typeof globalThis.crypto?.getRandomValues === "function") {
        globalThis.crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export class MeshPersistence {
    /**
     * @param {object} deps
     * @param {() => object|null} deps.getEngine  engine with geometryRevision + mesh
     * @param {() => object} deps.serializeMesh   full mesh payload (plain arrays)
     * @param {() => object|null} [deps.serializeMeshBuffers] typed-array payload for the worker path
     * @param {(mesh: object) => void} deps.applyMesh  load restored geometry into the app
     * @param {() => void} deps.resyncWidget      re-write the widget stub (ref changed / restore landed)
     * @param {(path: string, options?: object) => Promise<Response>} deps.fetchApi
     * @param {(() => Worker|null)} [deps.createWorker]  override/disable worker creation (tests)
     */
    constructor(deps) {
        this._getEngine = deps.getEngine;
        this._serializeMesh = deps.serializeMesh;
        this._serializeMeshBuffers = deps.serializeMeshBuffers || null;
        this._applyMesh = deps.applyMesh;
        this._resyncWidget = deps.resyncWidget;
        this._fetchApi = deps.fetchApi;
        this._onStatus = deps.onStatus || (() => { });
        this._createWorker = deps.createWorker !== undefined
            ? deps.createWorker
            : () => this._createDefaultWorker();

        this.meshRef = null;
        this.pendingRestore = false;

        this._destroyed = false;
        this._uploadTimer = null;
        this._uploadChain = Promise.resolve();
        this._uploadErrorLogged = false;
        this._restoreErrorLogged = false;
        this._lastUploadedRevision = -1;
        this._restoreGeneration = 0;
        this._restoreAbort = null;
        this._restorePromise = Promise.resolve(false);
        this._uploadAbort = null;
        this._pendingRestoreBaseRevision = -1;
        this._worker = null;
        this._workerFailed = false;
        this._workerJobId = 0;
        this._workerJobs = new Map();
        this._sessionId = createSessionId();
    }

    /**
     * Widget-sync gate. While a restore is pending the widget still holds the
     * stub with the server ref; overwriting it with the placeholder primitive
     * would lose the mesh on the next workflow save. Syncing resumes when the
     * restore lands or the user actually edits geometry.
     */
    shouldBlockWidgetSync() {
        if (!this.pendingRestore) return false;
        const engine = this._getEngine();
        if (!engine || engine.geometryRevision === this._pendingRestoreBaseRevision) {
            return true;
        }
        this.cancelRestore();
        return false;
    }

    /** True only when the current in-memory geometry is durably referenced. */
    isCurrentRevisionStored() {
        const engine = this._getEngine();
        return !!(
            this.meshRef &&
            engine &&
            engine.geometryRevision === this._lastUploadedRevision
        );
    }

    /** Called when the widget stub was just written; keeps the store current. */
    noteStubSynced() {
        if (this._destroyed) return;
        if (!this.meshRef) {
            // Without a ref, a workflow saved right now would lose the mesh
            // entirely, so upload immediately instead of debouncing.
            this._clearUploadTimer();
            this.uploadNow();
            return;
        }
        this._clearUploadTimer();
        this._uploadTimer = setTimeout(() => {
            this._uploadTimer = null;
            this.uploadNow();
        }, MESH_UPLOAD_DEBOUNCE_MS);
    }

    /** Serialized upload queue: each call runs after the previous completes. */
    uploadNow() {
        this._uploadChain = this._uploadChain
            .catch(() => { })
            .then(() => this._performUpload());
        return this._uploadChain;
    }

    /** Flush any pending debounce and wait for the store to be current. */
    async ensureUploaded() {
        this._clearUploadTimer();
        await this.uploadNow();
        return this.isCurrentRevisionStored() ? this.meshRef : null;
    }

    /** The user replaced the mesh locally; a stale restore must not land on it. */
    cancelRestore() {
        this._restoreGeneration++;
        this._restoreAbort?.abort();
        this.pendingRestore = false;
    }

    /** Restore geometry for a workflow stub that carries a server ref. */
    beginRestore(ref) {
        if (typeof ref !== "string" || !MESH_REF_PATTERN.test(ref)) {
            return Promise.resolve(false);
        }
        this.meshRef = ref;
        this.pendingRestore = true;
        this._onStatus("restoring", { ref });
        const engine = this._getEngine();
        this._pendingRestoreBaseRevision = engine ? engine.geometryRevision : -1;
        this._restorePromise = this._performRestore(ref);
        return this._restorePromise;
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this.cancelRestore();
        this._restoreAbort = null;
        this._uploadAbort?.abort();
        this._uploadAbort = null;
        this._clearUploadTimer();
        if (this._worker) {
            try {
                this._worker.terminate();
            } catch {
                /* ignore */
            }
            this._worker = null;
        }
        for (const job of this._workerJobs.values()) {
            job.reject(new Error("mesh persistence destroyed"));
        }
        this._workerJobs.clear();
        // Release the session lease only once the aborted requests have settled,
        // so a late server handler cannot recreate it after the DELETE.
        void Promise.allSettled([this._uploadChain, this._restorePromise])
            .then(() => this._fetchApi(`/sculpt/session/${this._sessionId}`, {
                method: "DELETE",
                keepalive: true
            }))
            .catch(() => { });
    }

    _clearUploadTimer() {
        if (this._uploadTimer !== null) {
            clearTimeout(this._uploadTimer);
            this._uploadTimer = null;
        }
    }

    async _performUpload() {
        if (this._destroyed) return;
        const engine = this._getEngine();
        const revision = engine ? engine.geometryRevision : -1;
        if (revision === this._lastUploadedRevision) {
            return;
        }
        try {
            this._onStatus("saving");
            const { body, hex } = await this._buildBodyAndHash();
            if (this._destroyed) return;
            // The ref is the content hash, so identical bytes are already stored.
            if (hex && hex === this.meshRef) {
                this._lastUploadedRevision = revision;
                this._resyncWidget();
                this._onStatus("saved", { ref: this.meshRef });
                return;
            }
            if (new TextEncoder().encode(body).byteLength > MAX_SCULPT_DATA_BYTES) {
                throw new Error("Sculpt mesh exceeds the upload size limit");
            }
            const abort = typeof AbortController === "function" ? new AbortController() : null;
            this._uploadAbort = abort;
            const out = await this._fetchJson("/sculpt/mesh", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Sculpt-Session": this._sessionId
                },
                body,
                ...(abort ? { signal: abort.signal } : {})
            }, abort);
            if (this._destroyed) return;
            if (typeof out?.ref !== "string" || !MESH_REF_PATTERN.test(out.ref)) {
                throw new Error("server returned an invalid mesh reference");
            }
            this._lastUploadedRevision = revision;
            this.meshRef = out.ref;
            this._resyncWidget();
            this._uploadErrorLogged = false;
            this._onStatus("saved", { ref: this.meshRef });
        } catch (e) {
            if (this._destroyed || (this._uploadAbort?.signal?.aborted && e.name !== "TimeoutError")) return;
            this._onStatus("upload-error", { error: e });
            if (!this._uploadErrorLogged) {
                console.error(
                    "Sculpt: server-side mesh persistence failed; a workflow saved now will not restore this mesh after reload.",
                    e
                );
                this._uploadErrorLogged = true;
            }
        } finally {
            this._uploadAbort = null;
        }
    }

    async _performRestore(ref) {
        const generation = ++this._restoreGeneration;
        const baseRevision = this._pendingRestoreBaseRevision;
        this._restoreAbort?.abort();
        const abort = typeof AbortController === "function" ? new AbortController() : null;
        this._restoreAbort = abort;
        try {
            const mesh = await this._fetchJson(
                `/sculpt/mesh/${ref}`,
                {
                    headers: { "X-Sculpt-Session": this._sessionId },
                    ...(abort ? { signal: abort.signal } : {})
                },
                abort
            );
            if (this._destroyed || generation !== this._restoreGeneration) return false;
            const engine = this._getEngine();
            if (engine && engine.geometryRevision !== baseRevision) {
                this.cancelRestore();
                return false;
            }
            const maxVerts = engine?.maxImportVertexCount ?? 300000;
            if (
                !Array.isArray(mesh?.vertices) ||
                !Array.isArray(mesh?.faces) ||
                mesh.vertices.length < 9 ||
                mesh.vertices.length % 3 !== 0 ||
                mesh.faces.length < 3 ||
                mesh.faces.length % 3 !== 0 ||
                mesh.faces.length > MAX_MESH_FACE_INDICES ||
                mesh.vertices.length / 3 > maxVerts
            ) {
                throw new Error("stored mesh payload is malformed");
            }
            const applied = this._applyMesh({
                schemaVersion: 5,
                vertices: mesh.vertices,
                faces: mesh.faces,
                uvs: Array.isArray(mesh.uvs) ? mesh.uvs : null,
                vertexOwners: Array.isArray(mesh.vertexOwners) ? mesh.vertexOwners : null,
                vertexMask: Array.isArray(mesh.vertexMask) ? mesh.vertexMask : undefined
            });
            if (applied === false) {
                throw new Error("stored mesh was rejected by the sculpt engine");
            }
            // Content just came from the store; no need to re-upload it.
            const engineAfter = this._getEngine();
            if (engineAfter) {
                this._lastUploadedRevision = engineAfter.geometryRevision;
            }
            if (generation === this._restoreGeneration) {
                this.pendingRestore = false;
                this._resyncWidget();
                this._onStatus("restored", { ref });
            }
            return true;
        } catch (e) {
            if (this._destroyed || generation !== this._restoreGeneration
                || (abort?.signal?.aborted && e.name !== "TimeoutError")) return false;
            if (!this._restoreErrorLogged) {
                console.error(
                    "Sculpt: could not restore mesh from server store; re-import the mesh if needed.",
                    e
                );
                this._restoreErrorLogged = true;
            }
            if (generation === this._restoreGeneration) {
                this._onStatus("restore-error", { ref, error: e });
            }
            return false;
        }
    }

    async _fetchJson(path, options, abort) {
        let timer;
        try {
            return await Promise.race([
                (async () => {
                    const response = await this._fetchApi(path, options);
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    return response.json();
                })(),
                new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        const error = new Error("Sculpt server request timed out");
                        error.name = "TimeoutError";
                        reject(error);
                        abort?.abort();
                    }, MESH_REQUEST_TIMEOUT_MS);
                })
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    /** Serialize + hash, off the main thread when a Worker is available. */
    async _buildBodyAndHash() {
        const viaWorker = await this._tryWorkerSerialize();
        if (viaWorker) {
            return viaWorker;
        }
        const body = JSON.stringify(this._serializeMesh());
        let hex = null;
        if (globalThis.crypto?.subtle) {
            const digest = await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(body)
            );
            hex = Array.from(new Uint8Array(digest))
                .map((b) => b.toString(16).padStart(2, "0"))
                .join("");
        }
        return { body, hex };
    }

    async _tryWorkerSerialize() {
        if (this._workerFailed || !this._serializeMeshBuffers) return null;
        if (!this._worker) {
            try {
                this._worker = this._createWorker ? this._createWorker() : null;
            } catch {
                this._worker = null;
            }
            if (!this._worker) {
                this._workerFailed = true;
                return null;
            }
            this._worker.onmessage = (e) => {
                const { id, body, hex, error } = e.data || {};
                const job = this._workerJobs.get(id);
                if (!job) return;
                this._workerJobs.delete(id);
                if (error || typeof body !== "string") {
                    job.reject(new Error(error || "worker returned no body"));
                } else {
                    job.resolve({ body, hex: hex || null });
                }
            };
            this._worker.onerror = () => {
                this._workerFailed = true;
                for (const job of this._workerJobs.values()) {
                    job.reject(new Error("mesh serialize worker crashed"));
                }
                this._workerJobs.clear();
            };
        }
        let buffers;
        try {
            buffers = this._serializeMeshBuffers();
        } catch {
            return null;
        }
        if (!buffers?.vertices || !buffers?.faces) return null;
        const id = ++this._workerJobId;
        const transfers = [buffers.vertices.buffer, buffers.faces.buffer];
        if (buffers.uvs) transfers.push(buffers.uvs.buffer);
        if (buffers.vertexOwners) transfers.push(buffers.vertexOwners.buffer);
        if (buffers.vertexMask) transfers.push(buffers.vertexMask.buffer);
        let timer;
        try {
            return await new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(new Error("Sculpt serialize worker timed out")), MESH_WORKER_TIMEOUT_MS);
                this._workerJobs.set(id, { resolve, reject });
                this._worker.postMessage({ id, ...buffers }, transfers);
            });
        } catch {
            // Fall back to the main-thread path for this and future uploads.
            this._workerFailed = true;
            this._worker?.terminate();
            this._worker = null;
            return null;
        } finally {
            clearTimeout(timer);
            this._workerJobs.delete(id);
        }
    }

    _createDefaultWorker() {
        if (typeof Worker !== "function") return null;
        return new Worker(new URL("../workers/meshSerializeWorker.js", import.meta.url));
    }
}
