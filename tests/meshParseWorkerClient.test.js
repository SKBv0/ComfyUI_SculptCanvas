import { describe, expect, it, vi } from "vitest";
import { Worker as NodeWorker } from "node:worker_threads";
import {
    MeshParseWorkerError,
    MESH_PARSE_WORKER_TIMEOUT_MS,
    parseMeshInWorker
} from "../js/core/meshParseWorkerClient.js";

class FakeWorker {
    constructor() {
        this.terminate = vi.fn();
        FakeWorker.instance = this;
    }

    postMessage(message) {
        this.message = message;
    }
}

describe("mesh parser worker client", () => {
    it("runs the production module worker and Three OBJ parser off-thread", async () => {
        const worker = new NodeWorker(
            new URL("./helpers/nodeWebWorkerHarness.mjs", import.meta.url),
            { type: "module" }
        );
        const result = await new Promise((resolve, reject) => {
            worker.once("message", resolve);
            worker.once("error", reject);
            worker.postMessage({
                kind: "obj",
                data: [
                    "v 0 0 0",
                    "v 1 0 0",
                    "v 0 1 0",
                    "vt 0 0",
                    "vt 1 0",
                    "vt 0 1",
                    "f 1/1 2/2 3/3"
                ].join("\n"),
                companionFiles: null
            });
        });
        await worker.terminate();

        expect(result.ok).toBe(true);
        expect(Array.from(result.result.faces)).toEqual([0, 1, 2]);
        expect(result.result.vertices).toHaveLength(9);
        expect(result.result.uvs).toHaveLength(6);
    });

    it("returns parsed geometry and terminates the worker", async () => {
        const pending = parseMeshInWorker("obj", "v 0 0 0", { WorkerCtor: FakeWorker });
        FakeWorker.instance.onmessage({
            data: {
                ok: true,
                result: {
                    vertices: new Float32Array(9),
                    faces: new Uint32Array([0, 1, 2]),
                    uvs: new Float32Array(6)
                }
            }
        });
        const result = await pending;
        expect(result.faces[2]).toBe(2);
        expect(FakeWorker.instance.terminate).toHaveBeenCalledOnce();
    });

    it("returns transferred data for an allowed main-thread fallback", async () => {
        const buffer = new ArrayBuffer(8);
        const pending = parseMeshInWorker("fbx", buffer, { WorkerCtor: FakeWorker });
        FakeWorker.instance.onmessage({
            data: {
                ok: false,
                error: "document is not defined",
                fallbackAllowed: true,
                returnedData: buffer
            }
        });
        await expect(pending).rejects.toMatchObject({
            name: "MeshParseWorkerError",
            fallbackAllowed: true,
            returnedData: buffer
        });
    });

    it("fails safely when Worker is unavailable", async () => {
        await expect(parseMeshInWorker("gltf", "{}", { WorkerCtor: null }))
            .rejects.toBeInstanceOf(MeshParseWorkerError);
    });

    it("terminates a stale parse when the import generation is cancelled", async () => {
        vi.useFakeTimers();
        let current = true;
        const pending = parseMeshInWorker("obj", "v 0 0 0", {
            WorkerCtor: FakeWorker,
            shouldApply: () => current
        });
        const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
        current = false;
        await vi.advanceTimersByTimeAsync(60);

        await rejected;
        expect(FakeWorker.instance.terminate).toHaveBeenCalledOnce();
        vi.useRealTimers();
    });

    it("terminates a parser worker that never responds", async () => {
        vi.useFakeTimers();
        const pending = parseMeshInWorker("obj", "v 0 0 0", { WorkerCtor: FakeWorker });
        const rejected = expect(pending).rejects.toMatchObject({
            name: "MeshParseWorkerError",
            fallbackAllowed: false
        });
        await vi.advanceTimersByTimeAsync(MESH_PARSE_WORKER_TIMEOUT_MS + 1);
        await rejected;
        expect(FakeWorker.instance.terminate).toHaveBeenCalledOnce();
        vi.useRealTimers();
    });
});
