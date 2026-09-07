import { PREVIEW_SIZE_MIN, PREVIEW_SIZE_MAX, PREVIEW_SIZE_DEFAULT } from "../engine/limits.js";
import { captureSquare, captureFov } from "../core/captureFrame.js";
import { WebGLRenderer } from "../renderer/WebGLRenderer.js";
import { COPY } from "./copy.js";

export const OFFSCREEN_CONTEXT_RELEASE_MS = 30_000;

// A single pass along a line leaves only about 2-3 overlapping dabs per point,
// far fainter than a dragged stroke. Repeating the pass brings the groove up to
// a comparable depth.
const LINE_STROKE_PASSES = 4;
const MAX_LINE_DABS = 128;

export class SculptCanvas {
    constructor(container, engine, onUpdate) {
        this.container = container;
        this.engine = engine;
        this.onUpdate = onUpdate;

        this.canvas = null;
        this.renderer = null;
        this.brushPanel = null;
        this.animationId = null;
        this._heartbeatTimer = null;
        this._destroyed = false;

        this.isDragging = false;
        this.isRotating = false;
        this.isPanning = false;
        this.isSculpting = false;
        this.isTemporarySmooth = false;

        this.lastMouseX = 0;
        this.lastMouseY = 0;
        this.lastSculptX = 0;
        this.lastSculptY = 0;

        this.lazyRadius = 16;
        this.lazyX = 0;
        this.lazyY = 0;
        this.lazyVelocityX = 0;
        this.lazyVelocityY = 0;
        this.lazyLastTime = 0;
        this.lazyStiffness = 140;
        this.lazyDamping = 24;
        this.lazyEnabled = false;

        this.activePointerId = null;
        this.currentPressure = 1.0;
        this.meshDirty = false;
        this.topologyDirty = false;
        this.lastMoveCanvasX = null;
        this.lastMoveCanvasY = null;
        this.lastStampX = 0;
        this.lastStampY = 0;
        this.lastStampTime = 0;
        this.strokeSpeedPxPerSec = 0;
        this.strokeSpacingPx = 0;
        this.strokeApplyMs = 0;
        this.strokePerfTier = "normal";
        this.strokePathRemainder = 0;
        this.maxStampGapMs = 20;
        this.maxStampsPerFrame = 6;
        this.pendingDirtyRanges = [];
        this.pendingNormalDirtyRanges = [];
        this._spatialRefreshHandle = null;
        this._spatialRefreshUsesIdleCallback = false;
        this._lineCommitInProgress = false;
        this._lineCommitGeneration = 0;
        this._lineCommitFrameId = null;
        this._lineCommitWaitResolve = null;
        this.pendingStrokeSamples = [];
        this.maskDirty = false;
        this.lineStrokeStart = null;
        this._eventHandlers = {};
        this._supportsPointerEvents = false;

        // Demand-driven rendering: frames are drawn only when something changed
        // (or during an active stroke). A slow heartbeat repaint catches any
        // state change that forgot to call requestRender().
        this._needsRender = true;
        this._visible = true;
        this._visObserver = null;
        this._offscreenReleaseTimer = null;
        this._errorElement = null;

        this._init();
    }

    /** Mark the viewport dirty; the next animation frame will redraw it. */
    requestRender() {
        if (this._destroyed) return;
        this._needsRender = true;
        if (this._heartbeatTimer !== null) {
            clearTimeout(this._heartbeatTimer);
            this._heartbeatTimer = null;
        }
        if (this._visible && !this.renderer) {
            this._ensureRenderer();
        }
        if (this._visible && this.renderer && this.animationId === null) {
            this._startRenderLoop();
        }
    }

    _ensureRenderer() {
        if (this.renderer || this._destroyed || !this.canvas) return !!this.renderer;
        try {
            this.renderer = new WebGLRenderer(this.canvas, {
                onContextLost: () => {
                    this.canvas.style.cursor = "wait";
                },
                onContextRestored: () => {
                    this.canvas.style.cursor = "crosshair";
                    this.renderer?.updateMesh(this.engine.mesh, { topologyChanged: true });
                    this.requestRender();
                }
            });
            this.syncRenderSettings();
            this.meshDirty = true;
            this.maskDirty = true;
            this.topologyDirty = true;
            this._errorElement?.remove();
            this._errorElement = null;
            return true;
        } catch (error) {
            this.renderer = null;
            console.error("Sculpt: Failed to initialize WebGL context.", error);
            this._showError("WebGL not supported");
            return false;
        }
    }

    _scheduleOffscreenContextRelease() {
        if (this._offscreenReleaseTimer !== null || !this.renderer) return;
        this._offscreenReleaseTimer = setTimeout(() => {
            this._offscreenReleaseTimer = null;
            if (this._destroyed || this._visible) return;
            this.renderer?.destroy();
            this.renderer = null;
        }, OFFSCREEN_CONTEXT_RELEASE_MS);
    }

    _cancelOffscreenContextRelease() {
        if (this._offscreenReleaseTimer !== null) {
            clearTimeout(this._offscreenReleaseTimer);
            this._offscreenReleaseTimer = null;
        }
    }

    _init() {
        this.canvas = document.createElement("canvas");
        this.canvas.setAttribute("role", "application");
        this.canvas.setAttribute("aria-label", COPY.viewportLabel);
        this.canvas.style.cssText = `
            width: 100%;
            height: 100%;
            display: block;
            cursor: crosshair;
            border-radius: 4px;
            outline: none;
            background: #111;
            touch-action: none;
        `;
        this.container.appendChild(this.canvas);

        // Thin square showing the part of the viewport preview_render keeps.
        this.captureGuide = document.createElement("div");
        this.captureGuide.setAttribute("aria-hidden", "true");
        this.captureGuide.style.cssText = `
            position: absolute;
            pointer-events: none;
            box-sizing: border-box;
            border: 1px solid rgba(255, 255, 255, 0.28);
            box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
            border-radius: 2px;
            display: none;
        `;
        this.container.appendChild(this.captureGuide);

        if (!this._ensureRenderer()) return;

        if (typeof IntersectionObserver === "function") {
            this._visObserver = new IntersectionObserver((entries) => {
                for (const entry of entries) {
                    this._visible = entry.isIntersecting;
                    if (this._visible) {
                        this._cancelOffscreenContextRelease();
                        // requestRender also restarts the parked loop.
                        this.requestRender();
                    } else {
                        if (this.animationId !== null) {
                            cancelAnimationFrame(this.animationId);
                            this.animationId = null;
                        }
                        if (this._heartbeatTimer !== null) {
                            clearTimeout(this._heartbeatTimer);
                            this._heartbeatTimer = null;
                        }
                        this._scheduleOffscreenContextRelease();
                    }
                }
            });
            this._visObserver.observe(this.canvas);
        }

        this._setupEvents();
        this._startRenderLoop();
        this._resize();
    }

    _showError(message) {
        const errorDiv = this._errorElement || document.createElement("div");
        errorDiv.setAttribute("role", "alert");
        errorDiv.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: center;
            width: 100%;
            height: 100%;
            background: #1a1a1d;
            color: #ff6b6b;
            font-family: sans-serif;
            font-size: 14px;
        `;
        errorDiv.textContent = message;
        if (!this._errorElement) {
            this._errorElement = errorDiv;
            this.container.appendChild(errorDiv);
        }
    }

    _setupEvents() {
        this._eventHandlers = {
            pointerdown: this._onPointerDown.bind(this),
            pointermove: this._onPointerMove.bind(this),
            pointerup: this._onPointerUp.bind(this),
            pointerleave: this._onPointerLeave.bind(this),
            pointercancel: this._onPointerUp.bind(this),
            mousedown: this._onMouseDown.bind(this),
            mousemove: this._onMouseMove.bind(this),
            mouseup: this._onMouseUp.bind(this),
            mouseleave: this._onMouseLeave.bind(this),
            wheel: this._onWheel.bind(this),
            contextmenu: (e) => e.preventDefault(),
            keydown: this._onKeyDown.bind(this),
            click: () => this.canvas.focus()
        };

        this._supportsPointerEvents = !!window.PointerEvent;
        if (this._supportsPointerEvents) {
            this.canvas.addEventListener("pointerdown", this._eventHandlers.pointerdown);
            this.canvas.addEventListener("pointermove", this._eventHandlers.pointermove);
            this.canvas.addEventListener("pointerup", this._eventHandlers.pointerup);
            this.canvas.addEventListener("pointerleave", this._eventHandlers.pointerleave);
            this.canvas.addEventListener("pointercancel", this._eventHandlers.pointercancel);
        } else {
            this.canvas.addEventListener("mousedown", this._eventHandlers.mousedown);
            this.canvas.addEventListener("mousemove", this._eventHandlers.mousemove);
            this.canvas.addEventListener("mouseup", this._eventHandlers.mouseup);
            this.canvas.addEventListener("mouseleave", this._eventHandlers.mouseleave);
        }

        this.canvas.addEventListener("wheel", this._eventHandlers.wheel, { passive: false });
        this.canvas.addEventListener("contextmenu", this._eventHandlers.contextmenu);

        this.canvas.tabIndex = 0;
        this.canvas.addEventListener("keydown", this._eventHandlers.keydown);
        this.canvas.addEventListener("click", this._eventHandlers.click);
    }

    _teardownEvents() {
        if (!this.canvas || !this._eventHandlers) {
            return;
        }

        if (this._supportsPointerEvents) {
            this.canvas.removeEventListener("pointerdown", this._eventHandlers.pointerdown);
            this.canvas.removeEventListener("pointermove", this._eventHandlers.pointermove);
            this.canvas.removeEventListener("pointerup", this._eventHandlers.pointerup);
            this.canvas.removeEventListener("pointerleave", this._eventHandlers.pointerleave);
            this.canvas.removeEventListener("pointercancel", this._eventHandlers.pointercancel);
        } else {
            this.canvas.removeEventListener("mousedown", this._eventHandlers.mousedown);
            this.canvas.removeEventListener("mousemove", this._eventHandlers.mousemove);
            this.canvas.removeEventListener("mouseup", this._eventHandlers.mouseup);
            this.canvas.removeEventListener("mouseleave", this._eventHandlers.mouseleave);
        }

        this.canvas.removeEventListener("wheel", this._eventHandlers.wheel, false);
        this.canvas.removeEventListener("contextmenu", this._eventHandlers.contextmenu);
        this.canvas.removeEventListener("keydown", this._eventHandlers.keydown);
        this.canvas.removeEventListener("click", this._eventHandlers.click);
        this._eventHandlers = {};
    }

    _onPointerDown(e) {
        if (this.activePointerId !== null && this.activePointerId !== e.pointerId) return;
        this.currentPressure = this._readPressure(e);
        this.activePointerId = e.pointerId;

        if (this.canvas.setPointerCapture && e.pointerId !== undefined) {
            try {
                this.canvas.setPointerCapture(e.pointerId);
            } catch (_) { }
        }

        this._onMouseDown(e);
    }

    _onPointerMove(e) {
        if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;
        // Coalesced pointer events bypass _onMouseMove below, so they must
        // explicitly keep the demand-driven renderer awake. Otherwise a
        // parked loop can display the accumulated stroke only on pointerup.
        this.requestRender();

        // Line mode commits once on release, but its endpoint cursor must still
        // follow the pointer so the interaction never looks frozen.
        if (this.isDragging && this.isSculpting && this.lineStrokeStart) {
            this.currentPressure = this._readPressure(e);
            this._onMouseMove(e);
            return;
        }
        if (this.isDragging && this.isSculpting && typeof e.getCoalescedEvents === "function") {
            const events = e.getCoalescedEvents();
            if (events && events.length > 0) {
                const applyMs = this.strokeApplyMs || 0;
                const maxEvents = applyMs > 7.0 ? 1 : (applyMs > 5.0 ? 2 : 4);
                const stride = Math.max(1, Math.ceil(events.length / maxEvents));
                for (let i = 0; i < events.length; i += stride) {
                    this._queueStrokeSampleFromEvent(events[i]);
                }
                const last = events[events.length - 1];
                if (last) {
                    this._queueStrokeSampleFromEvent(last);
                }
                this._syncLastMouseFromEvent(last || e);
                return;
            }
            this._queueStrokeSampleFromEvent(e);
            this._syncLastMouseFromEvent(e);
            return;
        }
        this.currentPressure = this._readPressure(e);
        this._onMouseMove(e);
    }

    _onPointerUp(e) {
        if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;
        this.currentPressure = 1.0;

        if (this.canvas.releasePointerCapture && e.pointerId !== undefined) {
            try {
                this.canvas.releasePointerCapture(e.pointerId);
            } catch (_) { }
        }

        this.activePointerId = null;
        this._onMouseUp(e);
    }

    _onPointerLeave(e) {
        if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;
        this.currentPressure = 1.0;
        this._onMouseLeave(e);
    }

    _readPressure(e) {
        if (e.pointerType === "mouse") return 1.0;
        return e.pressure && e.pressure > 0 ? e.pressure : 1.0;
    }

    _syncLastMouseFromEvent(e) {
        if (!e) return;
        const { x, y } = this._getMousePos(e);
        this.lastMouseX = x;
        this.lastMouseY = y;
    }

    _queueStrokeSampleFromEvent(e) {
        const sm = this.engine.strokeMode || "continuous";
        if (sm === "dragDot" || (sm === "line" && this.lineStrokeStart)) {
            return;
        }
        const { x, y } = this._getMousePos(e);
        this.pendingStrokeSamples.push({
            x,
            y,
            invert: !!(e.ctrlKey || e.altKey),
            pressure: this._readPressure(e)
        });
    }

    _onMouseDown(e) {
        e.preventDefault();
        if (this._lineCommitInProgress) return;
        this._cancelSpatialIndexRefresh();
        this.canvas.focus();
        this.requestRender();

        const { x, y, inside } = this._getMousePos(e);
        if (!inside && this.activePointerId === null) return;

        this.lastMouseX = x;
        this.lastMouseY = y;
        this.isDragging = true;
        this.isTemporarySmooth = false;
        this.lastMoveCanvasX = null;
        this.lastMoveCanvasY = null;

        const isAlt = e.altKey;
        const isShift = e.shiftKey;

        if (e.button === 0 && !isAlt && !isShift) {
            const sm = this.engine.strokeMode || "continuous";
            if (sm === "dragDot") {
                this.engine.startStroke();
                this.lazyX = x;
                this.lazyY = y;
                const rect = this.canvas.getBoundingClientRect();
                const invert = e.ctrlKey || e.altKey;
                // One pointer action performs one bounded dab. Repeating ten
                // dense-mesh dabs synchronously could block pointerdown for
                // hundreds of milliseconds.
                this._sculptSingle(x, y, invert, rect);
                this.engine.endStroke({ deferSpatialRefresh: true });
                this._scheduleSpatialIndexRefresh();
                this.onUpdate?.("stroke");
                this.brushPanel?.refresh?.();
                this.isDragging = false;
                return;
            }
            if (sm === "line") {
                this.lineStrokeStart = {
                    x,
                    y,
                    invert: !!(e.ctrlKey || e.altKey)
                };
                this.isSculpting = true;
                this.engine.startStroke();
                this.lazyX = x;
                this.lazyY = y;
                this.lazyVelocityX = 0;
                this.lazyVelocityY = 0;
                this.lazyLastTime = performance.now();
                this.canvas.style.cursor = "none";
                return;
            }

            this.isSculpting = true;
            this.engine.startStroke();

            this.lazyX = x;
            this.lazyY = y;
            this.lazyVelocityX = 0;
            this.lazyVelocityY = 0;
            this.lazyLastTime = performance.now();
            this.lastSculptX = x;
            this.lastSculptY = y;
            this.lastStampX = x;
            this.lastStampY = y;
            this.lastStampTime = performance.now();
            this.strokePathRemainder = 0;
            this.pendingStrokeSamples.length = 0;
            this.pendingDirtyRanges.length = 0;
            this.pendingNormalDirtyRanges.length = 0;
            this.strokePerfTier = "normal";
            this.maxStampsPerFrame = 6;

            this._sculptSingle(x, y, e.ctrlKey || e.altKey, this.canvas.getBoundingClientRect());
            this.canvas.style.cursor = "none";
            return;
        }

        if (e.button === 0 && isShift && !isAlt) {
            // Temporary smooth stroke
            this.isSculpting = true;
            this.isTemporarySmooth = true;
            this.engine.startStroke();

            this.lazyX = x;
            this.lazyY = y;
            this.lazyVelocityX = 0;
            this.lazyVelocityY = 0;
            this.lazyLastTime = performance.now();
            this.lastSculptX = x;
            this.lastSculptY = y;
            this.lastStampX = x;
            this.lastStampY = y;
            this.lastStampTime = performance.now();
            this.strokePathRemainder = 0;
            this.pendingStrokeSamples.length = 0;
            this.pendingDirtyRanges.length = 0;
            this.pendingNormalDirtyRanges.length = 0;
            this.strokePerfTier = "normal";
            this.maxStampsPerFrame = 6;

            this._sculptSingle(x, y, false, this.canvas.getBoundingClientRect());
            this.canvas.style.cursor = "none";
            return;
        }

        if (e.button === 1) {
            this.isPanning = true;
            this.canvas.style.cursor = "grab";
            return;
        }

        if (e.button === 2 || (e.button === 0 && isAlt)) {
            this.isRotating = true;
            this.canvas.style.cursor = "grabbing";
        }
    }

    _onMouseMove(e) {
        this.requestRender();
        const { x, y, inside } = this._getMousePos(e);
        const deltaX = x - this.lastMouseX;
        const deltaY = y - this.lastMouseY;

        if (this.isDragging) {
            if (this.isSculpting && this.lineStrokeStart) {
                this._updateCursor(x, y);
            } else if (this.isSculpting) {
                this.pendingStrokeSamples.push({
                    x,
                    y,
                    invert: !!(e.ctrlKey || e.altKey),
                    pressure: this.currentPressure
                });
            } else if (this.isRotating) {
                const minSize = Math.max(1, Math.min(this.canvas.clientWidth || 1, this.canvas.clientHeight || 1));
                const rotateScale = (Math.PI / minSize) * 0.84;
                this.engine.rotateCamera(deltaX * rotateScale, deltaY * rotateScale);
            } else if (this.isPanning) {
                this.engine.panCamera(deltaX * 0.9, deltaY * 0.9);
            }
        } else if (inside) {
            this._updateCursor(x, y);
        } else {
            this.renderer?.hideCursor();
            this.canvas.style.cursor = "crosshair";
        }

        this.lastMouseX = x;
        this.lastMouseY = y;
    }

    async _onMouseUp(e) {
        this.requestRender();
        if (this.isSculpting) {
            const sm = this.engine.strokeMode || "continuous";
            if (sm === "line" && this.lineStrokeStart) {
                this._flushPendingStrokeSamples();
                const rect = this.canvas.getBoundingClientRect();
                const inv = this.lineStrokeStart.invert;
                this._lineCommitInProgress = true;
                try {
                    await this._applyLineStrokes(
                        this.lineStrokeStart.x,
                        this.lineStrokeStart.y,
                        this.lastMouseX,
                        this.lastMouseY,
                        inv,
                        rect
                    );
                } finally {
                    this._lineCommitInProgress = false;
                    this.lineStrokeStart = null;
                }
                if (this._destroyed) return;
            } else {
                this._flushPendingStrokeSamples();
            }
            this.engine.endStroke({ deferSpatialRefresh: true });
            this.onUpdate?.("stroke");
            // The stroke changed undo/redo availability, so the panel's
            // history buttons need to pick up the new state.
            this.brushPanel?.refresh?.();
        }

        const cameraChanged = this.isRotating || this.isPanning;
        this.isDragging = false;
        this.isRotating = false;
        this.isPanning = false;
        this.isSculpting = false;
        this.isTemporarySmooth = false;
        this.lastMoveCanvasX = null;
        this.lastMoveCanvasY = null;
        this.lazyVelocityX = 0;
        this.lazyVelocityY = 0;
        this.lazyLastTime = 0;
        this.lastStampTime = 0;
        this.strokeSpeedPxPerSec = 0;
        this.strokeSpacingPx = 0;
        this.strokeApplyMs = 0;
        this.strokePerfTier = "normal";
        this.strokePathRemainder = 0;
        this.pendingStrokeSamples.length = 0;
        this.pendingDirtyRanges.length = 0;
        this.pendingNormalDirtyRanges.length = 0;
        this.maxStampsPerFrame = 6;
        this.lineStrokeStart = null;
        this.canvas.style.cursor = "crosshair";
        if (cameraChanged) this.onUpdate?.("camera");
        this._scheduleSpatialIndexRefresh();
    }

    _scheduleSpatialIndexRefresh() {
        if (!this.engine?.octreeDirty || this._spatialRefreshHandle !== null) return;
        const run = () => {
            this._spatialRefreshHandle = null;
            this._spatialRefreshUsesIdleCallback = false;
            if (this._destroyed || this.isSculpting) return;
            this.engine.flushSpatialIndex();
        };
        if (typeof requestIdleCallback === "function") {
            this._spatialRefreshUsesIdleCallback = true;
            this._spatialRefreshHandle = requestIdleCallback(run, { timeout: 500 });
        } else {
            this._spatialRefreshHandle = setTimeout(run, 80);
        }
    }

    _cancelSpatialIndexRefresh() {
        if (this._spatialRefreshHandle === null) return;
        if (this._spatialRefreshUsesIdleCallback && typeof cancelIdleCallback === "function") {
            cancelIdleCallback(this._spatialRefreshHandle);
        } else {
            clearTimeout(this._spatialRefreshHandle);
        }
        this._spatialRefreshHandle = null;
        this._spatialRefreshUsesIdleCallback = false;
    }

    _onMouseLeave(e) {
        if (this.isDragging && this.activePointerId !== null) return;
        this._onMouseUp(e);
        this.renderer?.hideCursor();
    }

    _getMousePos(e) {
        const rect = this.canvas.getBoundingClientRect();
        const clientX = typeof e.clientX === "number" ? e.clientX : rect.left;
        const clientY = typeof e.clientY === "number" ? e.clientY : rect.top;
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        const inside = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height;
        return { x, y, inside };
    }

    _onWheel(e) {
        e.preventDefault();
        this.requestRender();
        const delta = Math.max(-120, Math.min(120, e.deltaY));
        this.engine.zoomCamera(delta);
    }

    _onKeyDown(e) {
        // Shortcut contract with ComfyUI: a key Sculpt handles is consumed
        // (preventDefault + stopPropagation) so it does not also fire the graph
        // binding of the same name, such as Ctrl+Z undoing graph edits. Any key
        // Sculpt does not handle passes through untouched, so ComfyUI bindings
        // like Ctrl+S and Ctrl+Enter keep working while sculpting.
        const consume = () => {
            e.preventDefault();
            e.stopPropagation();
        };
        const isCmdOrCtrl = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();

        const wantsUndo = isCmdOrCtrl && !e.shiftKey && !e.altKey && key === "z";
        const wantsRedo =
            (isCmdOrCtrl && !e.shiftKey && !e.altKey && key === "y") ||
            (isCmdOrCtrl && e.shiftKey && !e.altKey && key === "z");

        if (!isCmdOrCtrl && !e.altKey && !e.shiftKey && key === "home") {
            consume();
            this.engine.frameCamera(true);
            this.onUpdate?.("camera");
            this.requestRender();
            return;
        }

        if (wantsUndo) {
            consume();
            this.requestRender();
            if (this.engine.undo()) {
                this.updateMesh();
                this.brushPanel?.refresh();
                this.onUpdate?.();
            }
            return;
        }

        if (wantsRedo) {
            consume();
            this.requestRender();
            if (this.engine.redo()) {
                this.updateMesh();
                this.brushPanel?.refresh();
                this.onUpdate?.();
            }
            return;
        }

        if (key === "m" && e.shiftKey && !isCmdOrCtrl && !e.altKey) {
            consume();
            this.requestRender();
            this.engine.maskPaintMode = !this.engine.maskPaintMode;
            this.brushPanel?.refresh();
            this.onUpdate?.();
            return;
        }

        // From here on only bare keys belong to Sculpt. Modifier combos such as
        // Ctrl+S or Alt+click carry ComfyUI meanings and must reach it
        // unhandled, rather than matching a bare brush shortcut below.
        if (isCmdOrCtrl || e.altKey) {
            return;
        }

        const brushKeys = {
            b: "standard",
            s: "smooth",
            i: "inflate",
            f: "flatten",
            p: "pinch",
            c: "crease",
            d: "clay",
            m: "move",
            t: "trim",
            h: "snake_hook",
            1: "standard",
            2: "smooth",
            3: "inflate",
            4: "clay",
            5: "crease",
            6: "move",
            7: "flatten",
            8: "pinch",
            9: "trim",
            0: "snake_hook"
        };

        if (brushKeys[key] && !e.shiftKey) {
            consume();
            this.requestRender();
            this.engine.activeBrush = brushKeys[key];
            this.brushPanel?.refresh();
            this.onUpdate?.("tool");
            return;
        }

        if (e.key === "[") {
            consume();
            this.requestRender();
            this.engine.brushRadius = Math.max(0.01, this.engine.brushRadius - 0.02);
            this.refreshCursorRadius();
            this.brushPanel?.refresh();
            this.onUpdate?.("tool");
        } else if (e.key === "]") {
            consume();
            this.requestRender();
            this.engine.brushRadius = Math.min(1.0, this.engine.brushRadius + 0.02);
            this.refreshCursorRadius();
            this.brushPanel?.refresh();
            this.onUpdate?.("tool");
        }
    }

    _updateLazyMouse(targetX, targetY) {
        if (!this.lazyEnabled || this.lazyRadius <= 0) {
            this.lazyX = targetX;
            this.lazyY = targetY;
            this.lazyVelocityX = 0;
            this.lazyVelocityY = 0;
            this.lazyLastTime = performance.now();
            return { x: targetX, y: targetY };
        }

        const now = performance.now();
        const dt = this.lazyLastTime > 0
            ? Math.min(0.04, Math.max(0.001, (now - this.lazyLastTime) / 1000))
            : (1 / 60);
        this.lazyLastTime = now;

        const dx = targetX - this.lazyX;
        const dy = targetY - this.lazyY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Keep brush position inside a leash while smoothing with spring-damper.
        let anchorX = targetX;
        let anchorY = targetY;
        if (dist > this.lazyRadius && dist > 1e-6) {
            const leashScale = (dist - this.lazyRadius) / dist;
            anchorX = this.lazyX + dx * leashScale;
            anchorY = this.lazyY + dy * leashScale;
        }

        const ax = (anchorX - this.lazyX) * this.lazyStiffness - this.lazyVelocityX * this.lazyDamping;
        const ay = (anchorY - this.lazyY) * this.lazyStiffness - this.lazyVelocityY * this.lazyDamping;
        this.lazyVelocityX += ax * dt;
        this.lazyVelocityY += ay * dt;

        // Velocity clamp avoids occasional spikes from irregular event timing.
        const maxVel = 2400;
        this.lazyVelocityX = Math.max(-maxVel, Math.min(maxVel, this.lazyVelocityX));
        this.lazyVelocityY = Math.max(-maxVel, Math.min(maxVel, this.lazyVelocityY));

        this.lazyX += this.lazyVelocityX * dt;
        this.lazyY += this.lazyVelocityY * dt;

        return { x: this.lazyX, y: this.lazyY };
    }

    _sculptWithInterpolation(x, y, invert, stampBudget = this.maxStampsPerFrame) {
        const maxStamps = Math.max(0, Math.floor(stampBudget));
        if (maxStamps === 0) {
            return { stampsApplied: 0, caughtUp: false };
        }
        const rect = this.canvas.getBoundingClientRect();
        const lazy = this._updateLazyMouse(x, y);
        const smoothX = lazy.x;
        const smoothY = lazy.y;

        let dx = smoothX - this.lastStampX;
        let dy = smoothY - this.lastStampY;
        let dist = Math.sqrt(dx * dx + dy * dy);

        const referenceSize = Math.max(1, Math.min(this.canvas.clientWidth || this.canvas.width, this.canvas.clientHeight || this.canvas.height));
        const brushRadiusPx = this.engine.brushRadius * referenceSize * 0.24;
        const isClay = this.engine.activeBrush === "clay" && !this.isTemporarySmooth;
        const now = performance.now();
        const dt = this.lastStampTime > 0 ? Math.max(0.001, (now - this.lastStampTime) / 1000) : (1 / 60);
        const speedPxPerSec = dist / dt;
        const baseStep = isClay ? brushRadiusPx * 0.16 : brushRadiusPx * 0.26;
        const speedFactor = Math.max(0.85, Math.min(1.35, 0.92 + speedPxPerSec / 2800));
        const perfPenalty = Math.max(0, this.strokeApplyMs - 5.0);
        const perfFactor = 1 + Math.min(0.45, perfPenalty * 0.08);
        const step = Math.max(0.75, Math.min(isClay ? 7.0 : 9.0, baseStep * speedFactor * perfFactor));
        this.strokeSpeedPxPerSec = speedPxPerSec;
        this.strokeSpacingPx = step;
        const tier = this.strokePerfTier;
        const carryDistance = dist + this.strokePathRemainder;
        const plannedStamps = Math.floor(carryDistance / Math.max(0.0001, step));
        const stampsToApply = Math.min(maxStamps, Math.max(0, plannedStamps));
        let stampsApplied = 0;

        // If the pointer travelled farther than this frame's stamp budget can
        // cover, spread the available stamps over the whole segment: the
        // deformation stays under the cursor instead of trailing several frames
        // behind it, at the cost of a lower dab density.
        if (plannedStamps > maxStamps && dist > 1e-6) {
            const startX = this.lastStampX;
            const startY = this.lastStampY;
            for (let i = 1; i <= maxStamps; i++) {
                const t = i / maxStamps;
                this._sculptSingle(
                    startX + (smoothX - startX) * t,
                    startY + (smoothY - startY) * t,
                    invert,
                    rect
                );
            }
            this.lastStampX = smoothX;
            this.lastStampY = smoothY;
            this.lastStampTime = now;
            this.lastSculptX = smoothX;
            this.lastSculptY = smoothY;
            this.strokePathRemainder = 0;
            return { stampsApplied: maxStamps, caughtUp: true };
        }

        while (dist >= step && step > 0.0001 && stampsApplied < stampsToApply) {
            if (dist <= 1e-6) break;
            const t = step / dist;
            const stampX = this.lastStampX + dx * t;
            const stampY = this.lastStampY + dy * t;
            this._sculptSingle(stampX, stampY, invert, rect);
            this.lastStampX = stampX;
            this.lastStampY = stampY;
            this.lastStampTime = now;
            stampsApplied++;
            dx = smoothX - this.lastStampX;
            dy = smoothY - this.lastStampY;
            dist = Math.sqrt(dx * dx + dy * dy);
        }

        this.strokePathRemainder = Math.max(
            0,
            Math.min(step * 1.5, carryDistance - (stampsApplied * step))
        );

        const dynamicMaxGapMs = isClay
            ? (tier === "degrade2" ? 34 : (tier === "degrade1" ? 28 : 22))
            : this.maxStampGapMs;
        const elapsedSinceStamp = now - this.lastStampTime;
        const forceContinuityStamp = elapsedSinceStamp >= dynamicMaxGapMs && dist > 0.04;
        const needsEndpointStamp =
            dist > step * (isClay ? 0.2 : 0.28) || forceContinuityStamp;
        if (needsEndpointStamp && stampsApplied < maxStamps) {
            this._sculptSingle(smoothX, smoothY, invert, rect);
            this.lastStampX = smoothX;
            this.lastStampY = smoothY;
            this.lastStampTime = now;
            this.strokePathRemainder = 0;
            stampsApplied++;
        }

        this.lastSculptX = smoothX;
        this.lastSculptY = smoothY;
        return {
            stampsApplied,
            caughtUp: !needsEndpointStamp || stampsApplied < maxStamps
                || (this.lastStampX === smoothX && this.lastStampY === smoothY)
        };
    }

    async _applyLineStrokes(x0, y0, x1, y1, invert, rect) {
        const generation = this._lineCommitGeneration || 0;
        const dx = x1 - x0;
        const dy = y1 - y0;
        const len = Math.sqrt(dx * dx + dy * dy);
        const referenceSize = Math.max(
            1,
            Math.min(this.canvas.clientWidth || this.canvas.width, this.canvas.clientHeight || this.canvas.height)
        );
        const brushRadiusPx = this.engine.brushRadius * referenceSize * 0.24;
        const step = Math.max(4, brushRadiusPx * 0.35);
        // Bound release work by estimated affected-vertex work. A fixed 128-dab
        // cap could still block for seconds on a 130k mesh with a large brush.
        const vertexCount = Math.max(1, this.engine.mesh?.vertexCount || 1);
        const symmetryFactor = this.engine.symmetry && this.engine.symmetry !== "none" ? 2 : 1;
        const estimatedVerticesPerDab = vertexCount * this.engine.brushRadius * this.engine.brushRadius * symmetryFactor;
        const dabsPerFrame = Math.max(1, Math.min(MAX_LINE_DABS, Math.floor(35_000 / Math.max(1, estimatedVerticesPerDab))));
        const maxSegmentsPerPass = Math.max(1, Math.floor(MAX_LINE_DABS / LINE_STROKE_PASSES) - 1);
        const n = len < 0.5
            ? 1
            : Math.min(maxSegmentsPerPass, Math.max(1, Math.ceil(len / step)));
        this.lastMoveCanvasX = null;
        this.lastMoveCanvasY = null;
        const points = [];
        for (let pass = 0; pass < LINE_STROKE_PASSES; pass++) {
            for (let i = 0; i <= n; i++) {
                const t = i / n;
                points.push([x0 + dx * t, y0 + dy * t]);
            }
        }
        for (let start = 0; start < points.length; start += dabsPerFrame) {
            if (this._destroyed || generation !== (this._lineCommitGeneration || 0)) return false;
            const end = Math.min(points.length, start + dabsPerFrame);
            for (let i = start; i < end; i++) {
                this._sculptSingle(points[i][0], points[i][1], invert, rect);
            }
            this.requestRender();
            if (end < points.length) {
                await new Promise((resolve) => {
                    const finish = () => {
                        this._lineCommitFrameId = null;
                        this._lineCommitWaitResolve = null;
                        resolve();
                    };
                    this._lineCommitWaitResolve = finish;
                    if (typeof requestAnimationFrame === "function") {
                        this._lineCommitFrameId = requestAnimationFrame(finish);
                    } else {
                        this._lineCommitFrameId = setTimeout(finish, 0);
                    }
                });
            }
        }
        return true;
    }

    _sculptSingle(x, y, invert, rect = null) {
        const bounds = rect || this.canvas.getBoundingClientRect();
        if (x < 0 || y < 0 || x > bounds.width || y > bounds.height) return;

        const { canvasX, canvasY } = this._toCanvasCoords(x, y, bounds);

        const hitInfo = this.engine.getHitInfo(canvasX, canvasY, this.canvas.width, this.canvas.height);
        const effectiveRadius = hitInfo
            ? this._computeWorldBrushRadiusAtPoint(hitInfo.point, bounds)
            : null;
        if (hitInfo) {
            this.renderer.setCursor(hitInfo.point, hitInfo.normal, true);
            this.renderer.cursorRadius = effectiveRadius;
            this.renderer.cursorInnerRatio = this.engine.innerRadiusRatio;
        } else {
            this.renderer.hideCursor();
        }

        const originalBrush = this.engine.activeBrush;
        if (this.isTemporarySmooth) {
            this.engine.activeBrush = "smooth";
        }

        const originalStrength = this.engine.brushStrength;
        this.engine.brushStrength = originalStrength * this.currentPressure;

        const referenceSize = Math.max(1, Math.min(this.canvas.clientWidth || this.canvas.width, this.canvas.clientHeight || this.canvas.height));
        const brushRadiusPx = this.engine.brushRadius * referenceSize * 0.24;
        const spacingWorld = effectiveRadius
            ? effectiveRadius * (this.strokeSpacingPx / Math.max(1.0, brushRadiusPx))
            : 0;

        let extraContext = {
            strokeContext: {
                pressure: this.currentPressure,
                speedPxPerSec: this.strokeSpeedPxPerSec,
                spacingPx: this.strokeSpacingPx,
                spacingWorld,
                applyMs: this.strokeApplyMs,
                timestampSec: performance.now() * 0.001,
                symmetry: this.engine.symmetry
            }
        };
        const moveLike = this.engine.activeBrush === "move" || this.engine.activeBrush === "snake_hook";
        if (hitInfo && moveLike) {
            const clip = this.engine.projectToClip(hitInfo.point, this.canvas.width, this.canvas.height);
            const depth = clip[2];
            const prevX = this.lastMoveCanvasX ?? canvasX;
            const prevY = this.lastMoveCanvasY ?? canvasY;
            const prevWorld = this.engine.unproject(prevX, prevY, this.canvas.width, this.canvas.height, depth);
            const currWorld = this.engine.unproject(canvasX, canvasY, this.canvas.width, this.canvas.height, depth);
            extraContext = {
                ...extraContext,
                moveDelta: [
                    (currWorld[0] - prevWorld[0]) * 0.9,
                    (currWorld[1] - prevWorld[1]) * 0.9,
                    (currWorld[2] - prevWorld[2]) * 0.9
                ]
            };
            this.lastMoveCanvasX = canvasX;
            this.lastMoveCanvasY = canvasY;
        }

        const sculptResult = hitInfo
            ? (() => {
                const t0 = performance.now();
                const out = this.engine.applyBrushAtHit(hitInfo, invert, effectiveRadius, extraContext);
                const dabMs = performance.now() - t0;
                this.strokeApplyMs = this.strokeApplyMs <= 0
                    ? dabMs
                    : (this.strokeApplyMs * 0.82 + dabMs * 0.18);
                return out;
            })()
            : null;

        if (this.engine.consumeTopologyChanged && this.engine.consumeTopologyChanged()) {
            this.topologyDirty = true;
        }

        this.engine.brushStrength = originalStrength;
        this.engine.activeBrush = originalBrush;

        const affected = sculptResult?.affectedIndices || null;
        if (sculptResult?.dirtyRanges?.length > 0) {
            this._mergeDirtyRanges(sculptResult.dirtyRanges);
        }
        if (sculptResult?.normalDirtyRanges?.length > 0) {
            this._mergeNormalDirtyRanges(sculptResult.normalDirtyRanges);
        }
        if (sculptResult?.perfSnapshot?.tier) {
            this.strokePerfTier = sculptResult.perfSnapshot.tier;
        }
        if (sculptResult?.maskOnly) {
            this.maskDirty = true;
        } else if (affected && affected.length > 0) {
            this.meshDirty = true;
        }
    }

    _updateCursor(x, y) {
        if (!this.renderer) return;

        const rect = this.canvas.getBoundingClientRect();
        const { canvasX, canvasY } = this._toCanvasCoords(x, y, rect);

        const hitInfo = this.engine.getHitInfo(canvasX, canvasY, this.canvas.width, this.canvas.height);
        if (hitInfo) {
            const effectiveRadius = this._computeWorldBrushRadiusAtPoint(hitInfo.point, rect);
            this.renderer.setCursor(hitInfo.point, hitInfo.normal, true);
            this.renderer.cursorRadius = effectiveRadius;
            this.renderer.cursorInnerRatio = this.engine.innerRadiusRatio;

            if (this.engine.symmetry !== "none") {
                const symPoint = [...hitInfo.point];
                const symNormal = [...hitInfo.normal];
                if (this.engine.symmetry === "x") {
                    symPoint[0] *= -1;
                    symNormal[0] *= -1;
                } else if (this.engine.symmetry === "y") {
                    symPoint[1] *= -1;
                    symNormal[1] *= -1;
                } else if (this.engine.symmetry === "z") {
                    symPoint[2] *= -1;
                    symNormal[2] *= -1;
                }
                this.renderer.setSymmetryCursor(symPoint, symNormal, true);
            } else {
                this.renderer.setSymmetryCursor(null, null, false);
            }

            this.canvas.style.cursor = "none";
            return;
        }

        this.renderer.hideCursor();
        this.canvas.style.cursor = "crosshair";
    }

    _flushPendingStrokeSamples() {
        if (!this.isSculpting || this.pendingStrokeSamples.length === 0) return;

        const sample = this.pendingStrokeSamples[this.pendingStrokeSamples.length - 1];
        this.pendingStrokeSamples.length = 0;
        this.currentPressure = sample.pressure;
        this._sculptWithInterpolation(
            sample.x,
            sample.y,
            sample.invert,
            Math.max(1, this.maxStampsPerFrame)
        );
    }

    _mergeDirtyRanges(incomingRanges) {
        this._mergeRanges(this.pendingDirtyRanges, incomingRanges);
    }

    _mergeNormalDirtyRanges(incomingRanges) {
        this._mergeRanges(this.pendingNormalDirtyRanges, incomingRanges);
    }

    _mergeRanges(targetRanges, incomingRanges) {
        if (!incomingRanges || incomingRanges.length === 0) return;
        for (const range of incomingRanges) {
            if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.count) || range.count <= 0) continue;
            targetRanges.push({
                start: Math.max(0, Math.floor(range.start)),
                count: Math.max(1, Math.floor(range.count))
            });
        }
        if (targetRanges.length <= 1) return;

        targetRanges.sort((a, b) => a.start - b.start);
        const merged = [];
        let current = { ...targetRanges[0] };
        for (let i = 1; i < targetRanges.length; i++) {
            const next = targetRanges[i];
            const currentEnd = current.start + current.count;
            if (next.start <= currentEnd + 2) {
                current.count = Math.max(currentEnd, next.start + next.count) - current.start;
                continue;
            }
            merged.push(current);
            current = { ...next };
        }
        merged.push(current);
        targetRanges.length = 0;
        if (merged.length <= 64) targetRanges.push(...merged);
    }

    _updateStrokeAdaptiveQuality() {
        if (!this.renderer) return;
        if (!this.isSculpting) {
            this.strokePerfTier = "normal";
            this.maxStampsPerFrame = 6;
            return;
        }
        const snapshot = this.engine.getPerfSnapshot?.() || { tier: "normal", applyMs: 0 };
        const measuredMs = Math.max(this.strokeApplyMs || 0, snapshot.applyMs || 0);
        this.strokePerfTier = measuredMs > 7.0
            ? "degrade2"
            : (measuredMs > 5.5 ? "degrade1" : (snapshot.tier || "normal"));

        if (this.strokePerfTier === "degrade2") {
            this.maxStampsPerFrame = 1;
            return;
        }
        if (this.strokePerfTier === "degrade1") {
            this.maxStampsPerFrame = 4;
            return;
        }
        this.maxStampsPerFrame = 6;
    }

    _startRenderLoop() {
        if (this.animationId !== null) return;
        const render = () => {
            this.animationId = null;
            if (!this._visible) {
                // Park the loop entirely while offscreen; the visibility
                // observer restarts it via requestRender().
                this.animationId = null;
                return;
            }
            this._needsRender = false;
            this._render();
            if (this.isSculpting) {
                this.animationId = requestAnimationFrame(render);
            } else if (this._heartbeatTimer === null) {
                this._heartbeatTimer = setTimeout(() => {
                    this._heartbeatTimer = null;
                    this.requestRender();
                }, 5000);
            }
        };
        this.animationId = requestAnimationFrame(render);
    }

    /** Square PNG, `size` px per edge, rendered offscreen so it does not depend on the node size. */
    captureViewportPngBase64(size = PREVIEW_SIZE_DEFAULT, options = {}) {
        if (!this.canvas || (!this.renderer && !this._ensureRenderer())) return null;
        const requested = Math.round(Number(size));
        const edge = Number.isFinite(requested)
            ? Math.max(PREVIEW_SIZE_MIN, Math.min(PREVIEW_SIZE_MAX, requested))
            : PREVIEW_SIZE_DEFAULT;
        const rect = this.canvas.getBoundingClientRect();
        const fov = captureFov(this.engine.camera.fov, rect.width, rect.height);
        const capture = this.renderer.withBufferSize(edge, edge, () => {
            this._render(fov);
            return this.renderer.readViewportPixels?.();
        });
        // Restoring the buffer size clears it; redraw so the viewport does not blank.
        this._render();
        if (!capture) return null;
        const { pixels, width: srcW, height: srcH } = capture;
        if (srcW < 1 || srcH < 1) return null;
        const scale = Math.min(1, edge / Math.max(srcW, srcH));
        const dstW = Math.max(1, Math.round(srcW * scale));
        const dstH = Math.max(1, Math.round(srcH * scale));
        const off = document.createElement("canvas");
        off.width = dstW;
        off.height = dstH;
        const ctx = off.getContext("2d");
        if (!ctx) return null;
        const bg = options.background === "transparent" ? "transparent" : "viewport";
        if (bg === "viewport") {
            const r = this.renderer;
            const cx = dstW * 0.5;
            const cy = dstH * 0.45;
            const rad = Math.max(dstW, dstH) * 0.85;
            const t = r.bgColorTop;
            const b = r.bgColorBottom;
            const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
            g.addColorStop(
                0,
                `rgb(${Math.round(t[0] * 255)},${Math.round(t[1] * 255)},${Math.round(t[2] * 255)})`
            );
            g.addColorStop(
                0.85,
                `rgb(${Math.round(b[0] * 255)},${Math.round(b[1] * 255)},${Math.round(b[2] * 255)})`
            );
            g.addColorStop(1, "rgb(10,10,12)");
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, dstW, dstH);
        }
        const pixelCanvas = document.createElement("canvas");
        pixelCanvas.width = srcW;
        pixelCanvas.height = srcH;
        const pixelContext = pixelCanvas.getContext("2d");
        if (!pixelContext) return null;
        pixelContext.putImageData(
            new ImageData(new Uint8ClampedArray(pixels.buffer), srcW, srcH),
            0,
            0
        );
        // WebGL readPixels is bottom-up; flip while scaling into the output.
        ctx.save();
        ctx.translate(0, dstH);
        ctx.scale(1, -1);
        ctx.drawImage(pixelCanvas, 0, 0, dstW, dstH);
        ctx.restore();
        const dataUrl = off.toDataURL("image/png");
        const comma = dataUrl.indexOf(",");
        if (comma < 0) return null;
        return dataUrl.slice(comma + 1);
    }

    _render(fovOverride = null) {
        if (!this.renderer) return;

        this._updateStrokeAdaptiveQuality();
        this._flushPendingStrokeSamples(false);

        if (this.meshDirty || this.maskDirty) {
            const topo = this.topologyDirty;
            // applyBrushAtHit already refreshed normals for the affected
            // vertices and their one-ring, which is the whole set a dab can
            // change, so no full recalculateNormals() is needed here. A full
            // pass costs about 7 ms per frame at the 260k adaptive cap.
            this.renderer.updateMesh(this.engine.mesh, {
                topologyChanged: topo,
                dirtyRanges: topo ? null : this.pendingDirtyRanges,
                normalDirtyRanges: topo ? null : this.pendingNormalDirtyRanges,
                maskChanged: this.maskDirty
            });
            this.meshDirty = false;
            this.maskDirty = false;
            this.topologyDirty = false;
            this.pendingDirtyRanges.length = 0;
            this.pendingNormalDirtyRanges.length = 0;
        }

        const aspect = this.canvas.width / this.canvas.height;
        const viewMatrix = this.engine.getViewMatrix();
        const projMatrix = this.engine.getProjectionMatrix(aspect, fovOverride);
        this.renderer.render(viewMatrix, projMatrix);
    }

    _toCanvasCoords(x, y, rect = null) {
        const bounds = rect || this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / bounds.width;
        const scaleY = this.canvas.height / bounds.height;
        return {
            canvasX: x * scaleX,
            canvasY: y * scaleY
        };
    }

    // brushRadius is screen-relative; the ring is in world units at the cursor depth.
    refreshCursorRadius() {
        if (!this.renderer || !this.renderer.cursorVisible) return;
        this.renderer.cursorRadius = this._computeWorldBrushRadiusAtPoint(this.renderer.cursorCenter);
        this.requestRender();
    }

    _computeWorldBrushRadiusAtPoint(worldPoint, rect = null) {
        const baseSize = Math.max(0.01, this.engine.brushRadius);
        const bounds = rect || this.canvas.getBoundingClientRect();
        const screenPx = baseSize * Math.min(bounds.width, bounds.height) * 0.24;

        const { distance, theta, phi, target, fov } = this.engine.camera;
        const eye = [
            distance * Math.sin(theta) * Math.cos(phi) + target[0],
            distance * Math.sin(phi) + target[1],
            distance * Math.cos(theta) * Math.cos(phi) + target[2]
        ];

        const dx = worldPoint[0] - eye[0];
        const dy = worldPoint[1] - eye[1];
        const dz = worldPoint[2] - eye[2];
        const depth = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const viewHeight = 2 * Math.tan((fov * Math.PI / 180) * 0.5) * depth;
        const worldPerPixel = viewHeight / Math.max(1, bounds.height);

        return Math.max(0.006, worldPerPixel * Math.max(2, screenPx));
    }

    _resize() {
        if (!this.renderer) return;
        const rect = this.container.getBoundingClientRect();
        const width = Math.floor(rect.width);
        const height = Math.floor(rect.height);

        if (width > 0 && height > 0) {
            this.renderer.resize(width, height);
            // Container CSS pixels; the rect above is scaled by the graph zoom.
            this._layoutCaptureGuide(this.container.clientWidth, this.container.clientHeight);
            this.requestRender();
        }
    }

    _layoutCaptureGuide(width, height) {
        const guide = this.captureGuide;
        if (!guide) return;
        const { left, top, side } = captureSquare(width, height);
        if (side <= 0) {
            guide.style.display = "none";
            return;
        }
        guide.style.display = "block";
        guide.style.left = `${left}px`;
        guide.style.top = `${top}px`;
        guide.style.width = `${side}px`;
        guide.style.height = `${side}px`;
    }

    updateMesh() {
        this.meshDirty = false;
        this.topologyDirty = false;
        this.pendingDirtyRanges.length = 0;
        this.pendingNormalDirtyRanges.length = 0;
        this.renderer?.updateMesh(this.engine.mesh, { topologyChanged: true });
        this.requestRender();
    }

    updateDeformation() {
        this.meshDirty = false;
        this.topologyDirty = false;
        this.pendingDirtyRanges.length = 0;
        this.pendingNormalDirtyRanges.length = 0;
        this.renderer?.updateMesh(this.engine.mesh, { topologyChanged: false });
        this.requestRender();
    }

    resize() {
        this._resize();
    }

    syncRenderSettings() {
        if (!this.renderer) return;
        this.renderer.matcapIntensity = this.engine.matcapIntensity ?? 1.0;
        this.renderer.setLightingPreset(this.engine.lightingPreset || "zbrush_red_wax");
        this.renderer.setLightControls({
            power: this.engine.lightPower,
            yaw: this.engine.lightYaw,
            pitch: this.engine.lightPitch
        });
        this.renderer.showGrid = !!this.engine.showGrid;
        this.renderer.showWireframe = !!this.engine.showWireframe;
        this.renderer.setBaseColor(this.engine.baseColor);
        this.renderer.setImportedDiffuse(this.engine.importedDiffuseImage);
        this.renderer.showImportedTexture = this.engine.showImportedTexture !== false;
        this.requestRender();
    }

    destroy() {
        this._destroyed = true;
        this.captureGuide?.remove();
        this.captureGuide = null;
        this._lineCommitGeneration++;
        if (this._lineCommitFrameId !== null) {
            if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this._lineCommitFrameId);
            else clearTimeout(this._lineCommitFrameId);
            this._lineCommitFrameId = null;
        }
        const resolveLineWait = this._lineCommitWaitResolve;
        this._lineCommitWaitResolve = null;
        resolveLineWait?.();
        if (this.animationId !== null) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
        if (this._heartbeatTimer !== null) {
            clearTimeout(this._heartbeatTimer);
            this._heartbeatTimer = null;
        }
        if (this._visObserver) {
            this._visObserver.disconnect();
            this._visObserver = null;
        }
        this._cancelOffscreenContextRelease();
        this._cancelSpatialIndexRefresh();
        this._teardownEvents();
        this.renderer?.destroy();
        this.renderer = null;
        this._errorElement?.remove();
        this._errorElement = null;
        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
    }
}
