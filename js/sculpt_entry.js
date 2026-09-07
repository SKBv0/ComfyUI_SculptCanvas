/** Sculpt Canvas frontend entry point. */

import { app } from "../../scripts/app.js";
import { NodeUI } from "./ui/NodeUI.js";

const SCULPT_NODE_TYPE = "SculptCanvas";
const SCULPT_STYLESHEET_ID = "comfyui-sculpt-canvas-stylesheet";
const SCULPT_PANEL_STYLESHEET_ID = "comfyui-sculpt-canvas-panel-stylesheet";

function ensureStyleSheet(id, relativeUrl) {
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = new URL(relativeUrl, import.meta.url).href;
    document.head.appendChild(link);
}

function cancelScheduledWork(node) {
    if (node._sculptSizeFrame !== null && node._sculptSizeFrame !== undefined) {
        cancelAnimationFrame(node._sculptSizeFrame);
        node._sculptSizeFrame = null;
    }
}

/**
 * LiteGraph gives no per-node teardown hook of its own, so wrap onConfigure and
 * onRemoved directly. onConfigure firing is also the only signal that this node
 * came from a saved workflow rather than a fresh drop on the canvas.
 */
function installInstanceLifecycle(node) {
    if (node._sculptLifecycleInstalled) return;
    node._sculptLifecycleInstalled = true;

    const originalConfigure = node.onConfigure;
    const originalRemoved = node.onRemoved;

    node.onConfigure = function () {
        this._sculptConfigured = true;
        return originalConfigure?.apply(this, arguments);
    };

    node.onRemoved = function () {
        cancelScheduledWork(this);
        this.sculptUI?.destroy();
        this.sculptUI = null;
        this.onConfigure = originalConfigure;
        this.onRemoved = originalRemoved;
        delete this._sculptLifecycleInstalled;
        return originalRemoved?.apply(this, arguments);
    };
}

ensureStyleSheet(SCULPT_STYLESHEET_ID, "./sculpt.css");
ensureStyleSheet(SCULPT_PANEL_STYLESHEET_ID, "./ui/brushPanel.css");

app.registerExtension({
    name: "ComfyUI.SculptCanvas",

    async nodeCreated(node) {
        if (node.comfyClass !== SCULPT_NODE_TYPE) return;

        installInstanceLifecycle(node);
        if (!node.sculptUI) node.sculptUI = new NodeUI(node);

        // nodeCreated runs before onConfigure, so defer sizing by a frame. A
        // node restored from a workflow only needs a floor under its saved size;
        // a freshly dropped one gets the roomier default.
        if (node._sculptSizeFrame != null) cancelAnimationFrame(node._sculptSizeFrame);
        node._sculptSizeFrame = requestAnimationFrame(() => {
            node._sculptSizeFrame = null;
            if (node._sculptConfigured) {
                node.size[0] = Math.max(node.size[0], 520);
                node.size[1] = Math.max(node.size[1], 580);
            } else {
                node.size[0] = Math.max(node.size[0], 680);
                node.size[1] = Math.max(node.size[1], 640);
            }
            node.setDirtyCanvas?.(true, true);
        });
    }
});
