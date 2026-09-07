/**
 * Client for the one-shot mesh parser worker. Each call owns a fresh Worker and
 * terminates it on the first settle, whether that is a result, an error, the
 * timeout, or the caller withdrawing consent via `options.shouldApply`.
 *
 * A rejection carries `fallbackAllowed` and `returnedData`: the caller may retry
 * the parse on the main thread only when the worker handed the input data back,
 * because an ArrayBuffer sent as a transferable is no longer readable here.
 */
export class MeshParseWorkerError extends Error {
    constructor(message, { fallbackAllowed = false, returnedData = null } = {}) {
        super(message);
        this.name = "MeshParseWorkerError";
        this.fallbackAllowed = fallbackAllowed;
        this.returnedData = returnedData;
    }
}

export const MESH_PARSE_WORKER_TIMEOUT_MS = 180000;

export function parseMeshInWorker(kind, data, options = {}) {
    const WorkerCtor = options.WorkerCtor ?? globalThis.Worker;
    if (typeof WorkerCtor !== "function") {
        return Promise.reject(new MeshParseWorkerError("Web Worker unavailable", {
            fallbackAllowed: true,
            returnedData: data
        }));
    }

    const worker = new WorkerCtor(new URL("../workers/meshParseWorker.js", import.meta.url), {
        type: "module"
    });
    let settled = false;
    let cancelTimer = null;
    let timeoutTimer = null;

    return new Promise((resolve, reject) => {
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            if (cancelTimer !== null) clearInterval(cancelTimer);
            if (timeoutTimer !== null) clearTimeout(timeoutTimer);
            worker.terminate();
            callback(value);
        };

        worker.onmessage = (event) => {
            const message = event.data || {};
            if (message.ok) {
                finish(resolve, message.result);
                return;
            }
            finish(reject, new MeshParseWorkerError(
                message.error || "mesh parser worker failed",
                {
                    fallbackAllowed: !!message.fallbackAllowed,
                    returnedData: message.returnedData ?? data
                }
            ));
        };
        worker.onerror = (event) => {
            finish(reject, new MeshParseWorkerError(
                event?.message || "mesh parser worker crashed",
                {
                    // A crashed worker cannot transfer the ArrayBuffer back, so
                    // its ownership is lost and no main-thread retry is possible.
                    fallbackAllowed: !(data instanceof ArrayBuffer),
                    returnedData: data instanceof ArrayBuffer ? null : data
                }
            ));
        };

        if (typeof options.shouldApply === "function") {
            cancelTimer = setInterval(() => {
                if (!options.shouldApply()) {
                    finish(reject, new DOMException("Mesh import cancelled", "AbortError"));
                }
            }, 50);
        }
        timeoutTimer = setTimeout(() => {
            finish(reject, new MeshParseWorkerError("mesh parser worker timed out"));
        }, MESH_PARSE_WORKER_TIMEOUT_MS);

        const message = {
            kind,
            data,
            companionFiles: options.companionFiles || options.textureFiles || null
        };
        const transfers = data instanceof ArrayBuffer ? [data] : [];
        try {
            worker.postMessage(message, transfers);
        } catch (error) {
            finish(reject, new MeshParseWorkerError(
                error?.message || "could not start mesh parser worker",
                { fallbackAllowed: true, returnedData: data }
            ));
        }
    });

}
