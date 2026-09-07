import { describe, expect, it, vi } from "vitest";
import { wrapWidgetCallback } from "../js/core/widgetCallback.js";

describe("Comfy widget callback compatibility", () => {
    it("preserves context, all arguments, and the original return value", () => {
        const context = { marker: "litegraph" };
        const original = vi.fn(function (...args) {
            expect(this).toBe(context);
            return { args };
        });
        const onValue = vi.fn();
        const widget = { callback: original };
        const { wrapped } = wrapWidgetCallback(widget, onValue);
        const args = ["cube", { canvas: true }, { node: true }, { type: "click" }];

        const result = wrapped.apply(context, args);

        expect(original).toHaveBeenCalledWith(...args);
        expect(onValue).toHaveBeenCalledWith("cube");
        expect(result).toEqual({ args });
    });
});
