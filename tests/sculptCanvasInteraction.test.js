import { describe, expect, it, vi } from "vitest";
import { SculptCanvas } from "../js/ui/SculptCanvas.js";

function makeCanvas(strokeMode = "continuous") {
    const canvas = Object.create(SculptCanvas.prototype);
    Object.assign(canvas, {
        activePointerId: 7,
        currentPressure: 1,
        engine: { strokeMode },
        isDragging: true,
        isSculpting: true,
        lineStrokeStart: null,
        pendingStrokeSamples: [],
        lastMouseX: 0,
        lastMouseY: 0,
        requestRender: vi.fn(),
        _updateCursor: vi.fn(),
        _getMousePos: (event) => ({ x: event.clientX, y: event.clientY, inside: true })
    });
    return canvas;
}

function pointerEvent(overrides = {}) {
    return {
        pointerId: 7,
        pointerType: "mouse",
        clientX: 30,
        clientY: 40,
        ctrlKey: false,
        altKey: false,
        ...overrides
    };
}

describe("SculptCanvas live stroke feedback", () => {
    it("keeps rendering while continuous strokes consume coalesced pointer events", () => {
        const canvas = makeCanvas();
        const first = pointerEvent({ clientX: 10, clientY: 20 });
        const last = pointerEvent({ clientX: 30, clientY: 40 });
        const event = pointerEvent({ getCoalescedEvents: () => [first, last] });

        canvas._onPointerMove(event);

        expect(canvas.requestRender).toHaveBeenCalled();
        expect(canvas.pendingStrokeSamples.length).toBeGreaterThan(0);
        expect(canvas.lastMouseX).toBe(30);
        expect(canvas.lastMouseY).toBe(40);
    });

    it("moves the endpoint cursor while a line stroke waits for release", () => {
        const canvas = makeCanvas("line");
        canvas.lineStrokeStart = { x: 5, y: 6, invert: false };

        canvas._onPointerMove(pointerEvent({ getCoalescedEvents: () => [] }));

        expect(canvas._updateCursor).toHaveBeenCalledWith(30, 40);
        expect(canvas.lastMouseX).toBe(30);
        expect(canvas.lastMouseY).toBe(40);
        expect(canvas.pendingStrokeSamples).toHaveLength(0);
    });

    it("uses the newest queued pointer sample with one frame-wide stamp budget", () => {
        const canvas = makeCanvas();
        canvas.strokePerfTier = "normal";
        canvas.maxStampsPerFrame = 6;
        canvas.pendingStrokeSamples = [
            { x: 10, y: 10, pressure: 1, invert: false },
            { x: 20, y: 20, pressure: 1, invert: false },
            { x: 30, y: 30, pressure: 1, invert: false },
            { x: 40, y: 40, pressure: 1, invert: false }
        ];
        canvas._sculptWithInterpolation = vi.fn((x, y, invert, budget) => ({
            stampsApplied: budget,
            caughtUp: true
        }));

        canvas._flushPendingStrokeSamples(false);

        expect(canvas._sculptWithInterpolation).toHaveBeenCalledOnce();
        expect(canvas._sculptWithInterpolation).toHaveBeenCalledWith(40, 40, false, 6);
        expect(canvas.pendingStrokeSamples).toEqual([]);
    });

    it("never exceeds the interpolation stamp budget while catching up", () => {
        const canvas = Object.create(SculptCanvas.prototype);
        Object.assign(canvas, {
            canvas: {
                width: 500,
                height: 500,
                clientWidth: 500,
                clientHeight: 500,
                getBoundingClientRect: () => ({ width: 500, height: 500 })
            },
            engine: { activeBrush: "standard", brushRadius: 0.15 },
            isTemporarySmooth: false,
            lastStampX: 0,
            lastStampY: 0,
            lastStampTime: 0,
            lastSculptX: 0,
            lastSculptY: 0,
            strokePathRemainder: 0,
            strokeApplyMs: 0,
            strokePerfTier: "normal",
            maxStampGapMs: 24,
            _updateLazyMouse: (x, y) => ({ x, y }),
            _sculptSingle: vi.fn()
        });

        const result = canvas._sculptWithInterpolation(100, 0, false, 6);

        expect(canvas._sculptSingle).toHaveBeenCalledTimes(6);
        expect(result).toEqual({ stampsApplied: 6, caughtUp: true });
        expect(canvas.lastStampX).toBe(100);
        expect(canvas.lastStampY).toBe(0);
    });

    it("caps a long line stroke to a fixed total amount of work", async () => {
        const canvas = Object.create(SculptCanvas.prototype);
        Object.assign(canvas, {
            canvas: { width: 512, height: 512, clientWidth: 512, clientHeight: 512 },
            engine: { brushRadius: 0.15 },
            lastMoveCanvasX: 1,
            lastMoveCanvasY: 1,
            _sculptSingle: vi.fn(),
            requestRender: vi.fn()
        });

        await canvas._applyLineStrokes(0, 0, 1000, 0, false, {
            width: 512,
            height: 512
        });

        expect(canvas._sculptSingle.mock.calls.length).toBeLessThanOrEqual(128);
    });

    it("spreads a dense full line across one-dab animation frames", async () => {
        vi.stubGlobal("requestAnimationFrame", vi.fn((callback) => {
            callback();
            return 1;
        }));
        const canvas = Object.create(SculptCanvas.prototype);
        Object.assign(canvas, {
            canvas: { width: 512, height: 512, clientWidth: 512, clientHeight: 512 },
            engine: {
                brushRadius: 1,
                symmetry: "none",
                mesh: { vertexCount: 130_000 }
            },
            lastMoveCanvasX: 1,
            lastMoveCanvasY: 1,
            _sculptSingle: vi.fn(),
            requestRender: vi.fn()
        });

        const pending = canvas._applyLineStrokes(0, 0, 1000, 0, false, { width: 512, height: 512 });

        expect(canvas._sculptSingle).toHaveBeenCalledTimes(1);
        await pending;
        expect(canvas._sculptSingle).toHaveBeenCalledTimes(100);
        expect(canvas.requestRender).toHaveBeenCalledTimes(100);
        vi.unstubAllGlobals();
    });

    it("cancels a pending line commit when the canvas is destroyed", async () => {
        const scheduled = [];
        vi.stubGlobal("requestAnimationFrame", vi.fn((callback) => {
            scheduled.push(callback);
            return 77;
        }));
        const cancel = vi.fn();
        vi.stubGlobal("cancelAnimationFrame", cancel);
        const canvas = Object.create(SculptCanvas.prototype);
        Object.assign(canvas, {
            canvas: { width: 512, height: 512, clientWidth: 512, clientHeight: 512, parentNode: null },
            engine: { brushRadius: 1, symmetry: "none", mesh: { vertexCount: 130_000 } },
            _destroyed: false,
            _lineCommitGeneration: 0,
            _lineCommitFrameId: null,
            _lineCommitWaitResolve: null,
            _sculptSingle: vi.fn(),
            requestRender: vi.fn(),
            animationId: null,
            _heartbeatTimer: null,
            _visObserver: null,
            _cancelOffscreenContextRelease: vi.fn(),
            _cancelSpatialIndexRefresh: vi.fn(),
            _teardownEvents: vi.fn(),
            renderer: null,
            _errorElement: null
        });

        const pending = canvas._applyLineStrokes(0, 0, 1000, 0, false, { width: 512, height: 512 });
        expect(canvas._sculptSingle).toHaveBeenCalledTimes(1);
        canvas.destroy();
        await expect(pending).resolves.toBe(false);
        expect(cancel).toHaveBeenCalledWith(77);
        expect(canvas._sculptSingle).toHaveBeenCalledTimes(1);
        vi.unstubAllGlobals();
    });

    it("reuses the batch bounds when computing world brush radius", () => {
        const canvas = Object.create(SculptCanvas.prototype);
        canvas.canvas = { getBoundingClientRect: vi.fn() };
        canvas.engine = {
            brushRadius: 0.15,
            camera: {
                distance: 3,
                theta: Math.PI / 4,
                phi: Math.PI / 6,
                target: [0, 0, 0],
                fov: 45
            }
        };

        const radius = canvas._computeWorldBrushRadiusAtPoint(
            [0, 0, 1],
            { width: 512, height: 512 }
        );

        expect(radius).toBeGreaterThan(0);
        expect(canvas.canvas.getBoundingClientRect).not.toHaveBeenCalled();
    });

    it("uses one dab per frame after a measured hard-limit overrun", () => {
        const canvas = Object.create(SculptCanvas.prototype);
        Object.assign(canvas, {
            renderer: {},
            engine: {
                getPerfSnapshot: () => ({ tier: "normal", applyMs: 0 })
            },
            isSculpting: true,
            strokeApplyMs: 12,
            strokePerfTier: "normal",
            maxStampsPerFrame: 6
        });

        canvas._updateStrokeAdaptiveQuality();

        expect(canvas.strokePerfTier).toBe("degrade2");
        expect(canvas.maxStampsPerFrame).toBe(1);
    });

    it("uses Home as a consumed viewport camera-recovery shortcut", () => {
        const canvas = Object.create(SculptCanvas.prototype);
        Object.assign(canvas, {
            engine: { frameCamera: vi.fn() },
            onUpdate: vi.fn(),
            requestRender: vi.fn()
        });
        const event = {
            key: "Home",
            ctrlKey: false,
            metaKey: false,
            altKey: false,
            shiftKey: false,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn()
        };

        canvas._onKeyDown(event);

        expect(canvas.engine.frameCamera).toHaveBeenCalledWith(true);
        expect(canvas.onUpdate).toHaveBeenCalledWith("camera");
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(event.stopPropagation).toHaveBeenCalledOnce();
    });
});
