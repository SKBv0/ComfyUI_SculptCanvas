import { parentPort } from "node:worker_threads";

globalThis.self = globalThis;
self.postMessage = (message, transfers = []) => parentPort.postMessage(message, transfers);

await import("../../js/workers/meshParseWorker.js");

parentPort.on("message", (data) => {
    self.onmessage({ data });
});
