import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PANEL_CSS = readFileSync(
    new URL("../js/ui/brushPanel.css", import.meta.url),
    "utf8"
);
const APP_SOURCE = readFileSync(
    new URL("../js/core/SculptApp.js", import.meta.url),
    "utf8"
);

describe("panel stylesheet integrity", () => {
    it("ships a non-trivial stylesheet", () => {
        expect(typeof PANEL_CSS).toBe("string");
        expect(PANEL_CSS.length).toBeGreaterThan(5000);
    });

    it("has balanced braces", () => {
        const open = (PANEL_CSS.match(/\{/g) || []).length;
        const close = (PANEL_CSS.match(/\}/g) || []).length;
        expect(open).toBe(close);
        expect(open).toBeGreaterThan(50);
    });

    it("keeps every rule scoped to the sculpt panel", () => {
        // Selectors are split on commas at rule starts; a bare element selector
        // would leak styling into the rest of the ComfyUI page.
        const selectors = PANEL_CSS
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .split("}")
            .map((chunk) => chunk.split("{")[0].trim())
            .filter((sel) => sel && !sel.startsWith("@") && !sel.includes(":root"));

        const leaked = selectors
            .flatMap((sel) => sel.split(","))
            .map((sel) => sel.trim())
            .filter((sel) => sel && !sel.startsWith("."));

        expect(leaked).toEqual([]);
    });

    it("bounds the panel with a definite height so children can scroll", () => {
        // A percentage max-height on the rail/flyout only resolves against a
        // parent with a definite height; top+bottom provides one.
        const root = PANEL_CSS.match(/\.sculpt-zpanel \{([\s\S]*?)\}/);
        expect(root).not.toBeNull();
        expect(root[1]).toMatch(/\btop:/);
        expect(root[1]).toMatch(/\bbottom:/);
        expect(root[1]).not.toMatch(/max-height:/);
    });

    it("keeps the shortcut strip in normal layout below the viewport", () => {
        const viewportEnd = APP_SOURCE.indexOf('</div>\n            <div class="sculpt-info-bar">');
        expect(viewportEnd).toBeGreaterThan(-1);

        const infoRule = APP_SOURCE.match(/\.sculpt-info-bar \{([\s\S]*?)\}/);
        expect(infoRule).not.toBeNull();
        expect(infoRule[1]).toMatch(/position:\s*relative/);
        expect(infoRule[1]).toMatch(/flex:\s*0 0 auto/);
        expect(infoRule[1]).not.toMatch(/position:\s*absolute/);
    });

    it("uses compact panel spacing without shrinking primary rail targets", () => {
        const root = PANEL_CSS.match(/\.sculpt-zpanel \{([\s\S]*?)\}/);
        const card = PANEL_CSS.match(/\.sculpt-zpanel-card \{([\s\S]*?)\}/);
        const railButton = PANEL_CSS.match(/\.sculpt-zpanel-rail-btn \{([\s\S]*?)\}/);

        expect(root[1]).toMatch(/gap:\s*4px/);
        expect(card[1]).toMatch(/padding:\s*5px 7px 6px/);
        expect(railButton[1]).toMatch(/width:\s*28px/);
        expect(railButton[1]).toMatch(/height:\s*28px/);
    });
});
