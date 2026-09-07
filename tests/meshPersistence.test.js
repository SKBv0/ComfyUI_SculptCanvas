import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash, webcrypto } from "node:crypto";
import { MeshPersistence, MESH_UPLOAD_DEBOUNCE_MS, MESH_REQUEST_TIMEOUT_MS, MESH_WORKER_TIMEOUT_MS } from "../js/core/MeshPersistence.js";

if (!globalThis.crypto?.subtle) {
    globalThis.crypto = webcrypto;
}

const REF64 = "ab".repeat(32);

function makeHarness({ fetchApi, applyMesh } = {}) {
    const engine = {
        geometryRevision: 1,
        maxImportVertexCount: 300000,
        mesh: { vertexCount: 60000 }
    };
    const calls = { posts: [], gets: [], resync: 0, applied: [], statuses: [] };
    const defaultFetch = async (path, options) => {
        if (options?.method === "POST") {
            calls.posts.push(options.body);
            // Content-addressed like the real server: ref = sha256(body)
            const hex = createHash("sha256").update(options.body).digest("hex");
            return { ok: true, json: async () => ({ ref: hex }) };
        }
        calls.gets.push(path);
        return {
            ok: true,
            json: async () => ({
                vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
                faces: [0, 1, 2]
            })
        };
    };
    const persistence = new MeshPersistence({
        getEngine: () => engine,
        serializeMesh: () => ({
            schemaVersion: 5,
            vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
            faces: [0, 1, 2]
        }),
        serializeMeshBuffers: null,
        applyMesh: (m) => applyMesh ? applyMesh(m, calls) : calls.applied.push(m),
        resyncWidget: () => calls.resync++,
        createWorker: () => null,
        fetchApi: fetchApi || defaultFetch,
        onStatus: (status) => calls.statuses.push(status)
    });
    return { persistence, engine, calls };
}

describe("MeshPersistence uploads", () => {
    let errSpy;
    beforeEach(() => {
        errSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    });
    afterEach(() => {
        errSpy.mockRestore();
        vi.useRealTimers();
    });

    it("uploads immediately when no ref exists yet", async () => {
        const { persistence, calls } = makeHarness();
        persistence.noteStubSynced();
        await persistence.ensureUploaded();
        expect(calls.posts.length).toBe(1);
        expect(persistence.meshRef).toMatch(/^[0-9a-f]{64}$/);
        expect(calls.resync).toBe(1);
    });

    it("reports whether the current geometry revision is durably referenced", async () => {
        const { persistence, engine } = makeHarness();
        expect(persistence.isCurrentRevisionStored()).toBe(false);
        await persistence.ensureUploaded();
        expect(persistence.isCurrentRevisionStored()).toBe(true);
        engine.geometryRevision++;
        expect(persistence.isCurrentRevisionStored()).toBe(false);
    });

    it("does not return a stale ref when geometry changes during upload", async () => {
        let resolvePost;
        const { persistence, engine } = makeHarness({
            fetchApi: () => new Promise((resolve) => {
                resolvePost = () => resolve({
                    ok: true,
                    json: async () => ({ ref: REF64 })
                });
            })
        });
        const pending = persistence.ensureUploaded();
        await vi.waitFor(() => expect(resolvePost).toBeTypeOf("function"));
        engine.geometryRevision++;
        resolvePost();
        expect(await pending).toBeNull();
        expect(persistence.meshRef).toBe(REF64);
        expect(persistence.isCurrentRevisionStored()).toBe(false);
    });

    it("treats a successful response without a valid ref as an upload error", async () => {
        const { persistence, calls } = makeHarness({
            fetchApi: async () => ({ ok: true, json: async () => ({ ref: "bad" }) })
        });
        expect(await persistence.ensureUploaded()).toBeNull();
        expect(calls.statuses).toContain("upload-error");
    });

    it("skips serialize+upload entirely when geometry revision is unchanged", async () => {
        const { persistence, calls } = makeHarness();
        await persistence.ensureUploaded();
        expect(calls.posts.length).toBe(1);
        await persistence.ensureUploaded();
        await persistence.ensureUploaded();
        expect(calls.posts.length).toBe(1);
    });

    it("debounces uploads once a ref exists", async () => {
        vi.useFakeTimers();
        const { persistence, engine, calls } = makeHarness();
        await persistence.ensureUploaded();
        expect(calls.posts.length).toBe(1);

        engine.geometryRevision++;
        persistence.noteStubSynced();
        expect(calls.posts.length).toBe(1);
        await vi.advanceTimersByTimeAsync(MESH_UPLOAD_DEBOUNCE_MS + 10);
        await persistence._uploadChain;
        // Same content bytes -> content hash matches the stored ref -> no POST.
        expect(calls.posts.length).toBe(1);
        expect(persistence._lastUploadedRevision).toBe(engine.geometryRevision);
    });

    it("re-POSTs when the geometry content actually changed", async () => {
        let payloadVariant = 0;
        const engineRef = { current: null };
        const calls = { posts: [] };
        const persistence = new MeshPersistence({
            getEngine: () => engineRef.current,
            serializeMesh: () => ({
                schemaVersion: 5,
                vertices: [payloadVariant, 0, 0, 1, 0, 0, 0, 1, 0],
                faces: [0, 1, 2]
            }),
            applyMesh: () => { },
            resyncWidget: () => { },
            createWorker: () => null,
            fetchApi: async (path, options) => {
                calls.posts.push(options.body);
                const hex = createHash("sha256").update(options.body).digest("hex");
                return { ok: true, json: async () => ({ ref: hex }) };
            }
        });
        engineRef.current = { geometryRevision: 1, mesh: { vertexCount: 60000 } };
        await persistence.ensureUploaded();
        const firstRef = persistence.meshRef;
        engineRef.current.geometryRevision = 2;
        payloadVariant = 7;
        await persistence.ensureUploaded();
        expect(calls.posts.length).toBe(2);
        expect(persistence.meshRef).not.toBe(firstRef);
    });

    it("keeps ref null and reports failure when the server rejects", async () => {
        const { persistence } = makeHarness({
            fetchApi: async () => ({ ok: false, status: 500, json: async () => ({}) })
        });
        const ref = await persistence.ensureUploaded();
        expect(ref).toBeNull();
        expect(persistence.meshRef).toBeNull();
        expect(errSpy).toHaveBeenCalled();
    });

    it("cancels a pending debounced upload on destroy", async () => {
        vi.useFakeTimers();
        const { persistence, engine, calls } = makeHarness();
        await persistence.ensureUploaded();
        engine.geometryRevision++;
        persistence.noteStubSynced();
        persistence.destroy();
        await vi.advanceTimersByTimeAsync(MESH_UPLOAD_DEBOUNCE_MS * 4);
        expect(calls.posts.length).toBe(1);
    });

    it("uses one session lease for uploads and releases it on destroy", async () => {
        const requests = [];
        const { persistence } = makeHarness({
            fetchApi: async (path, options = {}) => {
                requests.push({ path, options });
                if (options.method === "DELETE") return { ok: true };
                const hex = createHash("sha256").update(options.body).digest("hex");
                return { ok: true, json: async () => ({ ref: hex }) };
            }
        });
        await persistence.ensureUploaded();
        const upload = requests.find((request) => request.options.method === "POST");
        const sessionId = upload.options.headers["X-Sculpt-Session"];
        expect(sessionId).toMatch(/^[0-9a-f]{32}$/);

        persistence.destroy();
        await vi.waitFor(() => expect(requests.some(
            (request) => request.path === `/sculpt/session/${sessionId}` &&
                request.options.method === "DELETE"
        )).toBe(true));
    });
});

describe("MeshPersistence restore", () => {
    let errSpy;
    beforeEach(() => {
        errSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    });
    afterEach(() => errSpy.mockRestore());

    it("applies the stored mesh and resyncs the widget", async () => {
        const { persistence, calls } = makeHarness();
        const ok = await persistence.beginRestore(REF64);
        expect(ok).toBe(true);
        expect(calls.applied.length).toBe(1);
        expect(calls.applied[0].vertices.length).toBe(9);
        expect(persistence.pendingRestore).toBe(false);
        expect(persistence.meshRef).toBe(REF64);
        expect(calls.resync).toBe(1);
    });

    it("blocks widget sync while pending, unblocks on user geometry edits", async () => {
        const { persistence, engine } = makeHarness({
            fetchApi: () => new Promise(() => { }) // never resolves
        });
        persistence.beginRestore(REF64);
        expect(persistence.shouldBlockWidgetSync()).toBe(true);
        expect(persistence.shouldBlockWidgetSync()).toBe(true);
        engine.geometryRevision++;
        expect(persistence.shouldBlockWidgetSync()).toBe(false);
        expect(persistence.pendingRestore).toBe(false);
    });

    it("ignores a stale restore response that resolves after a newer one", async () => {
        let resolveFirst;
        const meshA = { vertices: [9, 9, 9, 1, 0, 0, 0, 1, 0], faces: [0, 1, 2] };
        const meshB = { vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], faces: [0, 1, 2] };
        let call = 0;
        const { persistence, calls } = makeHarness({
            fetchApi: (path) => {
                call++;
                if (call === 1) {
                    return new Promise((resolve) => {
                        resolveFirst = () => resolve({ ok: true, json: async () => meshA });
                    });
                }
                return Promise.resolve({ ok: true, json: async () => meshB });
            }
        });
        const first = persistence.beginRestore("11".repeat(32));
        const second = persistence.beginRestore("22".repeat(32));
        await second;
        resolveFirst();
        const firstResult = await first;
        expect(firstResult).toBe(false);
        expect(calls.applied.length).toBe(1);
        expect(calls.applied[0].vertices[0]).toBe(0); // mesh B won
    });

    it("rejects malformed stored payloads without applying them", async () => {
        const { persistence, calls } = makeHarness({
            fetchApi: async () => ({
                ok: true,
                json: async () => ({ vertices: [0, 0, 0], faces: [0, 1, 2, 3] })
            })
        });
        const ok = await persistence.beginRestore(REF64);
        expect(ok).toBe(false);
        expect(calls.applied.length).toBe(0);
        expect(calls.statuses).toContain("restore-error");
        expect(errSpy).toHaveBeenCalled();
    });

    it("reports restore failure when the sculpt engine rejects the payload", async () => {
        const { persistence, calls } = makeHarness({
            applyMesh: (mesh, state) => {
                state.applied.push(mesh);
                return false;
            }
        });
        expect(await persistence.beginRestore(REF64)).toBe(false);
        expect(calls.applied).toHaveLength(1);
        expect(calls.statuses).toContain("restore-error");
        expect(persistence.pendingRestore).toBe(true);
    });

    it("cancelRestore unblocks widget sync and invalidates in-flight fetches", async () => {
        let resolveFetch;
        const { persistence, calls } = makeHarness({
            fetchApi: () => new Promise((resolve) => {
                resolveFetch = () => resolve({
                    ok: true,
                    json: async () => ({ vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], faces: [0, 1, 2] })
                });
            })
        });
        const p = persistence.beginRestore(REF64);
        expect(persistence.shouldBlockWidgetSync()).toBe(true);
        persistence.cancelRestore();
        expect(persistence.shouldBlockWidgetSync()).toBe(false);
        resolveFetch();
        expect(await p).toBe(false);
        expect(calls.applied.length).toBe(0);
    });
});

describe("MeshPersistence failure and race regressions", () => {
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    it.each([false, true])("rejects late restore after a local edit (widget sync=%s)", async (sync) => {
        let resolve;
        const { persistence, engine, calls } = makeHarness({ fetchApi: () => new Promise(r => { resolve = r; }) });
        const restoring = persistence.beginRestore(REF64);
        engine.geometryRevision++;
        if (sync) expect(persistence.shouldBlockWidgetSync()).toBe(false);
        resolve({ ok: true, json: async () => ({ vertices: [0,0,0,1,0,0,0,1,0], faces: [0,1,2] }) });
        expect(await restoring).toBe(false);
        expect(calls.applied).toHaveLength(0);
    });

    it("times out a stalled upload and allows the next retry", async () => {
        vi.useFakeTimers();
        vi.spyOn(console, "error").mockImplementation(() => {});
        let stall = true;
        const { persistence, calls } = makeHarness({ fetchApi: async () => {
            if (stall) return new Promise(() => {});
            return { ok: true, json: async () => ({ ref: REF64 }) };
        } });
        persistence._buildBodyAndHash = async () => ({ body: JSON.stringify(persistence._serializeMesh()), hex: null });
        const first = persistence.ensureUploaded();
        await vi.advanceTimersByTimeAsync(MESH_REQUEST_TIMEOUT_MS + 1);
        expect(await first).toBeNull();
        expect(calls.statuses).toContain("upload-error");
        stall = false;
        expect(await persistence.ensureUploaded()).toBe(REF64);
        expect(calls.statuses.at(-1)).toBe("saved");
    });

    it("times out a stalled response body and leaves the restore stub protected", async () => {
        vi.useFakeTimers();
        vi.spyOn(console, "error").mockImplementation(() => {});
        const { persistence, calls } = makeHarness({ fetchApi: async () => ({
            ok: true, json: () => new Promise(() => {})
        }) });
        const restoring = persistence.beginRestore(REF64);
        await vi.advanceTimersByTimeAsync(MESH_REQUEST_TIMEOUT_MS + 1);
        expect(await restoring).toBe(false);
        expect(persistence.shouldBlockWidgetSync()).toBe(true);
        expect(calls.statuses).toContain("restore-error");
    });

    it("terminates a silent worker and falls back to current geometry", async () => {
        vi.useFakeTimers();
        const worker = { postMessage: vi.fn(), terminate: vi.fn() };
        const { persistence } = makeHarness();
        persistence._createWorker = () => worker;
        persistence._serializeMeshBuffers = () => ({
            vertices: new Float32Array([0,0,0,1,0,0,0,1,0]), faces: new Uint32Array([0,1,2])
        });
        const result = persistence.ensureUploaded();
        await vi.advanceTimersByTimeAsync(MESH_WORKER_TIMEOUT_MS + 1);
        expect(await result).toMatch(/^[a-f0-9]{64}$/);
        expect(worker.terminate).toHaveBeenCalledOnce();
        expect(persistence._workerJobs.size).toBe(0);
    });
});
