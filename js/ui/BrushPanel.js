/**
 * BrushPanel - Core sculpting controls
 */

import { EXPORT_FORMATS, PRIMITIVE_TYPES, SUBDIVISION_MIN, SUBDIVISION_MAX } from "../engine/limits.js";
import {
    selectMeshImport,
    formatMiB,
    MAX_MESH_FILE_BYTES,
    MAX_COMPANION_FILE_BYTES,
    MAX_COMPANION_FILES,
    MAX_TOTAL_IMPORT_BYTES
} from "../core/meshImportSelection.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/**
 * Icon set. Every glyph declares xmlns because `_createIcon` runs a strict
 * image/svg+xml parse; see the note there.
 *
 * Brush glyphs share one grammar so ten tools stay distinguishable at 15px:
 * a surface cross-section (baseline near y=19) plus the deformation that brush
 * produces. Utility glyphs use conventional shapes. Stroke width is 1.75
 * throughout with round caps and joins.
 */
const SVG_OPEN = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"`
    + ` stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">`;
const svgIcon = (body) => `${SVG_OPEN}${body}</svg>`;

const ICONS = {
    // Surface pushed out into a smooth dome, arrow marking the push direction.
    standard: svgIcon(
        `<path d="M3 18.5c3.6 0 3.6-7 9-7s5.4 7 9 7"/>`
        + `<path d="M12 8.6V4.2M9.9 6.3L12 4.2l2.1 2.1"/>`
    ),
    // Rough profile above resolving into a flat one below.
    smooth: svgIcon(
        `<path d="M3.2 8c2 0 2-3.4 4-3.4S9.2 8 11.2 8s2-3.4 4-3.4S17.2 8 19.2 8"/>`
        + `<path d="M12 11v2.6M10.6 12.6L12 14l1.4-1.4"/>`
        + `<path d="M3.5 17.5h17"/>`
    ),
    // Volume expanding outward: diagonal arrows so it never reads as `move`.
    inflate: svgIcon(
        `<circle cx="12" cy="12" r="4.1"/>`
        + `<path d="M15.4 8.6l3.8-3.8M15.6 4.6h3.8v3.8"/>`
        + `<path d="M8.6 8.6L4.8 4.8M8.4 4.6H4.6v3.8"/>`
        + `<path d="M15.4 15.4l3.8 3.8M15.6 19.4h3.8v-3.8"/>`
        + `<path d="M8.6 15.4l-3.8 3.8M8.4 19.4H4.6v-3.8"/>`
    ),
    // A press bar driving a bumpy profile down to a flat one.
    flatten: svgIcon(
        `<path d="M3.5 5.5h17"/>`
        + `<path d="M8 8.4v2.8M6.7 9.9L8 11.2l1.3-1.3M16 8.4v2.8M14.7 9.9L16 11.2l1.3-1.3"/>`
        + `<path d="M3.5 18.5h17"/>`
    ),
    // Material squeezed toward a centre line from both sides.
    pinch: svgIcon(
        `<path d="M12 4.5v15"/>`
        + `<path d="M3.4 12h5.2M6.2 9.6L8.6 12l-2.4 2.4"/>`
        + `<path d="M20.6 12h-5.2M17.8 9.6L15.4 12l2.4 2.4"/>`
    ),
    // A sharp V groove cut into the surface.
    crease: svgIcon(`<path d="M3 8.5h5.6L12 17.5l3.4-9H21"/>`),
    // Clay builds up in stacked layers, so the mound shows strata.
    clay: svgIcon(
        `<path d="M3.5 19h17"/>`
        + `<path d="M6 19c0-5.2 2.7-8.4 6-8.4s6 3.2 6 8.4"/>`
        + `<path d="M7.6 15.4h8.8M9.2 12.6h5.6"/>`
    ),
    // Whole region dragged: axis-aligned arrows.
    move: svgIcon(
        `<path d="M12 3.6v16.8M3.6 12h16.8"/>`
        + `<path d="M9.5 6.1L12 3.6l2.5 2.5M9.5 17.9L12 20.4l2.5-2.5"/>`
        + `<path d="M6.1 9.5L3.6 12l2.5 2.5M17.9 9.5L20.4 12l-2.5 2.5"/>`
    ),
    // Everything past the plane is sheared back onto it, leaving a flat top.
    trim: svgIcon(
        `<path d="M3.5 19.5h17"/>`
        + `<path d="M6.6 19.5c0-4.3 2.4-7 5.4-7s5.4 2.7 5.4 7"/>`
        + `<path d="M2.6 12.5h18.8"/>`
    ),
    // A tendril dragged out of the surface, curling at the tip.
    snake_hook: svgIcon(
        `<path d="M3.5 19.5h17"/>`
        + `<path d="M7.8 19.5c0-5.6 2.4-9.2 5.9-10.5"/>`
        + `<path d="M13.7 9c2.3-.8 4.2.3 4.2 2.1 0 1.7-1.9 2.5-3 1.3"/>`
    ),

    undo: svgIcon(`<path d="M8.8 8.2H4V3.4"/><path d="M4 12.8a8 8 0 1 0 2.4-5.7L4 9.4"/>`),
    redo: svgIcon(`<path d="M15.2 8.2H20V3.4"/><path d="M20 12.8a8 8 0 1 1-2.4-5.7L20 9.4"/>`),
    reset: svgIcon(`<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>`),
    wire: svgIcon(
        `<rect x="4.6" y="4.6" width="14.8" height="14.8" rx="1.8"/>`
        + `<path d="M4.6 9.5h14.8M4.6 14.5h14.8M9.5 4.6v14.8M14.5 4.6v14.8"/>`
    ),
    // Ground plane in perspective rather than stacked chevrons.
    floor: svgIcon(
        `<path d="M2.6 19.4h18.8"/>`
        + `<path d="M5.8 15.2h12.4M8.4 11.4h7.2"/>`
        + `<path d="M2.6 19.4l5.8-8M21.4 19.4l-5.8-8M12 19.4v-8"/>`
    ),
    // Symmetry: a mirror plane with the shape reflected across it. The axis
    // letter is rendered as text beside the glyph, so the picture carries the
    // concept and the orientation carries the axis.
    off: svgIcon(`<circle cx="12" cy="12" r="7.6"/><path d="M6.6 17.4L17.4 6.6"/>`),
    x: svgIcon(
        `<path d="M12 3.4v17.2" stroke-dasharray="2.6 2.3"/>`
        + `<path d="M9.4 8.4L4.8 12l4.6 3.6z" fill="currentColor"/>`
        + `<path d="M14.6 8.4L19.2 12l-4.6 3.6z" fill="currentColor"/>`
    ),
    y: svgIcon(
        `<path d="M3.4 12h17.2" stroke-dasharray="2.6 2.3"/>`
        + `<path d="M8.4 9.4L12 4.8l3.6 4.6z" fill="currentColor"/>`
        + `<path d="M8.4 14.6L12 19.2l3.6-4.6z" fill="currentColor"/>`
    ),
    z: svgIcon(
        `<path d="M5 19L19 5" stroke-dasharray="2.6 2.3"/>`
        + `<path d="M6.1 10.4l1.3 6.2 6.2 1.3z" fill="currentColor"/>`
        + `<path d="M17.9 13.6l-1.3-6.2-6.2-1.3z" fill="currentColor"/>`
    ),
    upload: svgIcon(
        `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>`
        + `<path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>`
    ),
    folder: svgIcon(`<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>`),
    export: svgIcon(
        `<path d="M12 4v10"/><path d="M8.5 7.5L12 4l3.5 3.5"/>`
        + `<path d="M5 14v3.5A1.5 1.5 0 0 0 6.5 19h11a1.5 1.5 0 0 0 1.5-1.5V14"/>`
    ),

    // Rail glyphs: one per section.
    settings: svgIcon(
        `<path d="M3.6 8.4h16.8M3.6 15.6h16.8"/>`
        + `<circle cx="9" cy="8.4" r="2.5"/><circle cx="15.4" cy="15.6" r="2.5"/>`
    ),
    stroke: svgIcon(
        `<path d="M3.4 16.6c4.2-8.4 13-8.4 17.2 0" stroke-dasharray="0.2 3.6"/>`
        + `<path d="M3.4 16.6c1.5-3 3.4-4.9 5.3-5.9"/>`
    ),
    mask: svgIcon(
        `<circle cx="12" cy="12" r="7.7"/>`
        + `<path d="M12 4.3a7.7 7.7 0 0 1 0 15.4z" fill="currentColor" stroke="none"/>`
    ),
    material: svgIcon(
        `<circle cx="12" cy="12" r="7.7"/>`
        + `<path d="M7 16.6a6.4 6.4 0 0 1 9-9"/>`
    ),
    light: svgIcon(
        `<circle cx="12" cy="12" r="3.9"/>`
        + `<path d="M12 3.2v2.3M12 18.5v2.3M3.2 12h2.3M18.5 12h2.3"/>`
        + `<path d="M5.9 5.9l1.6 1.6M16.5 16.5l1.6 1.6M18.1 5.9l-1.6 1.6M7.5 16.5l-1.6 1.6"/>`
    ),
    lightControl: svgIcon(
        `<circle cx="12" cy="12" r="3.3"/>`
        + `<path d="M14.4 9.6L19.4 4.6"/><path d="M15.2 4.6h4.2v4.2"/>`
        + `<path d="M4.6 19.4a10.6 10.6 0 0 1 3.1-7.5"/>`
    ),
    presets: svgIcon(
        `<circle cx="7.7" cy="8.6" r="3.5"/>`
        + `<rect x="13" y="5.1" width="6.9" height="6.9" rx="1.3"/>`
        + `<path d="M4.4 19.4h15.2"/>`
    )
};

const MATERIAL_SWATCHES = [
    { id: "red_wax", label: "Red Wax", color: [0.38, 0.08, 0.02] },
    { id: "grey_clay", label: "Grey Clay", color: [0.29, 0.29, 0.29] },
    { id: "skin", label: "Skin Clay", color: [0.40, 0.30, 0.21] },
    { id: "jade", label: "Jade", color: [0.18, 0.47, 0.32] },
    { id: "porcelain", label: "Porcelain", color: [0.44, 0.43, 0.40] },
    { id: "basalt", label: "Basalt", color: [0.14, 0.13, 0.15] },
    { id: "ivory", label: "Ivory", color: [0.49, 0.46, 0.42] },
    { id: "bronze_clay", label: "Bronze Clay", color: [0.31, 0.22, 0.13] }
];

const LIGHT_RIGS = [
    {
        id: "zbrush_red_wax",
        label: "Red Wax",
        preview: "linear-gradient(118deg, #e8b896 0%, #9d4f38 38%, #3d2218 100%)"
    },
    {
        id: "neutral_grey_clay",
        label: "Grey",
        preview: "linear-gradient(120deg, #c4c4c4 0%, #6e6e6e 52%, #383838 100%)"
    },
    {
        id: "soft_fill",
        label: "Soft",
        preview: "linear-gradient(145deg, #f0ece6 0%, #9e9890 100%)"
    },
    {
        id: "rim_dramatic",
        label: "Rim",
        preview: "linear-gradient(100deg, #0c0e14 25%, #2a3a52 55%, #6eb4f0 100%)"
    },
    {
        id: "studio_portrait",
        label: "Studio",
        preview: "linear-gradient(132deg, #ffd8b8 0%, #c67b5c 48%, #4a2c28 100%)"
    },
    {
        id: "museum_clay",
        label: "Museum",
        preview: "linear-gradient(180deg, #faf8f4 0%, #b8b4ac 100%)"
    },
    {
        id: "daylight_balanced",
        label: "Daylight",
        preview: "linear-gradient(125deg, #f4fbff 0%, #8ec4e8 100%)"
    },
    {
        id: "noir_workshop",
        label: "Noir",
        preview: "linear-gradient(138deg, #241830 0%, #0f0c14 55%, #3a2848 100%)"
    }
];

export class BrushPanel {
    constructor(container, engine, options = {}) {
        this.container = container;
        this.engine = engine;
        this.onUpdate = options.onUpdate;
        this.onPresetSelect = options.onPresetSelect;
        this.getExportSetting = options.getExportSetting;
        this.setExportSetting = options.setExportSetting;
        this._exportSyncers = [];

        this.element = null;
        this.brushButtons = {};
        this.strokeModeButtons = {};
        this.maskPaintButton = null;
        this.matButtons = {};
        this.lightButtons = {};
        this.symButtons = {};
        this.wireframeButton = null;
        this.floorButton = null;
        this.undoButton = null;
        this.redoButton = null;
        this._radiusSlider = null;
        this._radiusValue = null;
        this._strengthSlider = null;
        this._strengthValue = null;
        this._glossSlider = null;
        this._glossValue = null;
        this._lightPowerDisplay = null;
        this._lightYawDisplay = null;
        this._lightPowerTrack = null;
        this._lightPowerFill = null;
        this._lightPowerKnob = null;
        this._lightPad = null;
        this._lightKnob = null;
        this._lightPadPointerId = null;
        this._lightPowerPointerId = null;
        this._importGeneration = 0;
        this._activeImportReader = null;

        // Collapsible-section state, persisted so the layout the user arranges
        // survives reloads. Keys map section id -> open boolean.
        this._sectionState = this._loadSectionState();

        this._init();
    }

    _loadSectionState() {
        try {
            const raw = localStorage.getItem("comfyui-sculpt-canvas.panelSections");
            const parsed = raw ? JSON.parse(raw) : null;
            return parsed && typeof parsed === "object" ? parsed : {};
        } catch {
            return {};
        }
    }

    _saveSectionState() {
        try {
            localStorage.setItem(
                "comfyui-sculpt-canvas.panelSections",
                JSON.stringify(this._sectionState)
            );
        } catch {
            /* storage unavailable; the layout just will not persist */
        }
    }

    _init() {
        this.element = document.createElement("div");
        this.element.className = "sculpt-zpanel";
        this._installTooltips();

        this.sectionTabs = {};
        this._sectionOrder = 0;

        this.rail = document.createElement("div");
        this.rail.className = "sculpt-zpanel-rail";
        this.rail.setAttribute("role", "toolbar");
        this.rail.setAttribute("aria-label", "Sculpt tool sections");

        this.flyout = document.createElement("div");
        this.flyout.className = "sculpt-zpanel-flyout";

        this.element.append(this.rail, this.flyout);

        this._createHeader();
        // Ordered by sculpting frequency: what you reach for on every stroke
        // sits at the top of the rail, setup and appearance below.
        this._createQuickBar();
        this._createBrushSection();
        const settingsBody = this._beginSection("Brush settings", "settings", true, "settings");
        this._createSlider("Radius", 0.01, 1.0, this.engine.brushRadius, (v) => {
            this.engine.brushRadius = v;
            this.onUpdate?.("radius");
        }, settingsBody);
        this._createSlider("Strength", 0.02, 2.0, this.engine.brushStrength, (v) => {
            this.engine.brushStrength = v;
            this.onUpdate?.("tool");
        }, settingsBody);
        this._createSlider("Gloss", 0.0, 2.0, this.engine.matcapIntensity ?? 1.0, (v) => {
            this.engine.matcapIntensity = v;
            this.onUpdate?.("render-settings");
        }, settingsBody);
        this._createStrokeModeSection();
        this._createMaskSection();
        this._createSymmetrySection();
        this._createMaterialSection();
        this._createLightingSection();
        this._createLightControlSection();
        this._createPresetsSection();
        this._createObjectOrientationSection();
        this._createViewImportSection();
        this._createExportSection();

        this._syncFlyoutState();
        this.container.appendChild(this.element);
    }

    _createHeader() {
        const header = document.createElement("button");
        header.type = "button";
        header.className = "sculpt-zpanel-header";
        header.dataset.tooltip = "Collapse / expand the tool panel";
        const badge = document.createElement("div");
        badge.className = "sculpt-zpanel-badge";
        const title = document.createElement("div");
        title.className = "sculpt-zpanel-title";
        title.textContent = "Sculpt";
        const chevron = document.createElement("span");
        chevron.className = "sculpt-zpanel-header-chevron";
        chevron.setAttribute("aria-hidden", "true");
        header.append(badge, title, chevron);
        const collapsed = !!this._sectionState.__panelCollapsed;
        if (collapsed) {
            this.element.classList.add("is-panel-collapsed");
        }
        header.setAttribute("aria-expanded", String(!collapsed));
        header.onclick = () => {
            const nowCollapsed = this.element.classList.toggle("is-panel-collapsed");
            header.setAttribute("aria-expanded", String(!nowCollapsed));
            this._sectionState.__panelCollapsed = nowCollapsed;
            this._saveSectionState();
        };
        this.rail.appendChild(header);
    }

    _createPresetsSection() {
        const body = this._beginSection("Mesh", "presets", false, "presets");
        const current = () => ({
            primitive: String(this.getExportSetting?.("primitive") ?? "sphere"),
            subdivision: Number(this.getExportSetting?.("subdivision") ?? 4)
        });
        const shapeButtons = {};
        const levelButtons = {};
        const sync = () => {
            const { primitive, subdivision } = current();
            for (const [key, btn] of Object.entries(shapeButtons)) {
                this._setPressed(btn, key === primitive);
            }
            for (const [key, btn] of Object.entries(levelButtons)) {
                this._setPressed(btn, Number(key) === subdivision);
            }
        };

        const shapes = document.createElement("div");
        shapes.className = "sculpt-zpanel-preset-grid";
        for (const primitive of PRIMITIVE_TYPES) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "sculpt-zpanel-preset";
            const nameEl = document.createElement("span");
            nameEl.className = "sculpt-zpanel-preset-name";
            nameEl.textContent = primitive.charAt(0).toUpperCase() + primitive.slice(1);
            btn.appendChild(nameEl);
            btn.dataset.tooltip = `Start over from a ${primitive}`;
            btn.onclick = () => {
                this.onPresetSelect?.(primitive, current().subdivision);
                this.onUpdate?.("preset");
                sync();
            };
            shapes.appendChild(btn);
            shapeButtons[primitive] = btn;
        }

        const label = document.createElement("div");
        label.className = "sculpt-zpanel-label";
        label.textContent = "Subdivision";
        const levels = document.createElement("div");
        levels.className = "sculpt-zpanel-segmented";
        for (let level = SUBDIVISION_MIN; level <= SUBDIVISION_MAX; level++) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "sculpt-zpanel-btn sculpt-zpanel-seg-btn";
            btn.textContent = String(level);
            btn.dataset.tooltip = `Rebuild the starting shape at density ${level}`;
            btn.onclick = () => {
                this.onPresetSelect?.(current().primitive, level);
                this.onUpdate?.("preset");
                sync();
            };
            levels.appendChild(btn);
            levelButtons[level] = btn;
        }

        body.append(shapes, label, levels);
        sync();
        this._exportSyncers.push(sync);
    }

    _createObjectOrientationSection() {
        const body = this._beginSection("Object orientation", "orientation", false, "reset");
        const section = document.createElement("div");
        section.className = "sculpt-zpanel-actions";
        const quarterTurn = Math.PI * 0.5;
        for (const axis of ["x", "y", "z"]) {
            for (const direction of [-1, 1]) {
                const degrees = direction * 90;
                const btn = document.createElement("button");
                btn.type = "button";
                btn.className = "sculpt-zpanel-btn";
                btn.textContent = `${axis.toUpperCase()} ${degrees > 0 ? "+" : "−"}90°`;
                btn.setAttribute("aria-label", `Rotate object ${axis.toUpperCase()} axis ${degrees} degrees`);
                btn.dataset.tooltip = "Bake orientation into the mesh; Undo restores it";
                btn.onclick = () => {
                    if (!this.engine.rotateObject(axis, direction * quarterTurn)) return;
                    this.onUpdate?.("mesh");
                    this._updateUndoRedoButtons();
                };
                section.appendChild(btn);
            }
        }
        body.appendChild(section);
    }

    _createStrokeModeSection() {
        const body = this._beginSection("Stroke mode", "stroke", true, "stroke");
        const section = document.createElement("div");
        section.className = "sculpt-zpanel-segmented";
        const modes = [
            { id: "continuous", label: "Flow", tip: "Continuous stroke" },
            { id: "dragDot", label: "Dot", tip: "Single dab per click (drag dot)" },
            { id: "line", label: "Line", tip: "Straight line preview; applies on release" }
        ];
        for (const m of modes) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "sculpt-zpanel-btn sculpt-zpanel-seg-btn";
            btn.textContent = m.label;
            btn.dataset.tooltip = m.tip;
            btn.onclick = () => {
                this.engine.strokeMode = m.id;
                this._updateStrokeModeButtons();
                this.onUpdate?.("tool");
            };
            section.appendChild(btn);
            this.strokeModeButtons[m.id] = btn;
        }
        body.appendChild(section);
        this._updateStrokeModeButtons();
    }

    _updateStrokeModeButtons() {
        const active = this.engine.strokeMode || "continuous";
        for (const id of Object.keys(this.strokeModeButtons)) {
            this._setPressed(this.strokeModeButtons[id], id === active);
        }
    }

    _createMaskSection() {
        const body = this._beginSection("Vertex mask", "mask", false, "mask");
        const section = document.createElement("div");
        section.className = "sculpt-zpanel-mask-grid";

        const paintBtn = document.createElement("button");
        paintBtn.type = "button";
        paintBtn.className = "sculpt-zpanel-btn sculpt-zpanel-chip";
        paintBtn.textContent = "Paint";
        paintBtn.dataset.tooltip = "Mask paint mode (Shift+M) — LMB add, Ctrl subtract";
        paintBtn.onclick = () => {
            this.engine.maskPaintMode = !this.engine.maskPaintMode;
            this._updateMaskModeButton();
            this.onUpdate?.("tool");
        };
        this.maskPaintButton = paintBtn;
        section.appendChild(paintBtn);

        const clearBtn = document.createElement("button");
        clearBtn.type = "button";
        clearBtn.className = "sculpt-zpanel-btn sculpt-zpanel-chip";
        clearBtn.textContent = "Clear";
        clearBtn.dataset.tooltip = "Clear the mask — every vertex becomes editable again";
        clearBtn.onclick = () => {
            this.engine.mesh.clearMask();
            this.onUpdate?.("mask");
        };
        section.appendChild(clearBtn);

        const invBtn = document.createElement("button");
        invBtn.type = "button";
        invBtn.className = "sculpt-zpanel-btn sculpt-zpanel-chip";
        invBtn.textContent = "Invert";
        invBtn.dataset.tooltip = "Swap masked and unmasked areas";
        invBtn.onclick = () => {
            this.engine.mesh.invertMask();
            this.onUpdate?.("mask");
        };
        section.appendChild(invBtn);

        const blurBtn = document.createElement("button");
        blurBtn.type = "button";
        blurBtn.className = "sculpt-zpanel-btn sculpt-zpanel-chip";
        blurBtn.textContent = "Blur";
        blurBtn.dataset.tooltip = "Soften mask edges so brushes fade in instead of stopping abruptly";
        blurBtn.onclick = () => {
            this.engine.mesh.blurMask(2);
            this.onUpdate?.("mask");
        };
        section.appendChild(blurBtn);

        body.appendChild(section);
        this._updateMaskModeButton();
    }

    _updateMaskModeButton() {
        if (this.maskPaintButton) {
            this._setPressed(this.maskPaintButton, !!this.engine.maskPaintMode);
        }
    }

    /**
     * Sections live behind an icon rail instead of a single tall stack.
     *
     * Each call adds one rail button and one card in the flyout column beside
     * it. Toggling a button shows or hides that card, and any number of cards
     * can be open at once; they stack in rail order, so the flyout holds only
     * what the user asked for rather than every control at once. Open/closed
     * state is persisted per section in `_sectionState`.
     */
    _beginSection(text, key, defaultOpen = true, iconName = "settings") {
        const stored = this._sectionState[key];
        const open = stored === undefined ? defaultOpen : !!stored;

        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "sculpt-zpanel-rail-btn";
        tab.dataset.tooltip = text;
        tab.setAttribute("aria-label", text);
        tab.appendChild(this._createIcon(iconName));

        const card = document.createElement("section");
        card.className = "sculpt-zpanel-card";
        card.dataset.sectionKey = key;
        // Rail order, so cards always stack in the same order regardless of
        // the sequence the user opened them in.
        card.style.order = String(this._sectionOrder++);

        const label = document.createElement("div");
        label.className = "sculpt-zpanel-label sculpt-zpanel-card-title";
        label.textContent = text;

        const body = document.createElement("div");
        body.className = "sculpt-zpanel-sec-body";

        card.append(label, body);

        const apply = (isOpen) => {
            card.style.display = isOpen ? "" : "none";
            tab.classList.toggle("is-active", isOpen);
            tab.setAttribute("aria-pressed", String(isOpen));
            tab.setAttribute("aria-expanded", String(isOpen));
        };
        apply(open);

        tab.onclick = () => {
            const nowOpen = card.style.display === "none";
            apply(nowOpen);
            this._sectionState[key] = nowOpen;
            this._saveSectionState();
            this._syncFlyoutState();
        };

        this.rail.appendChild(tab);
        this.flyout.appendChild(card);
        this.sectionTabs[key] = { tab, card };
        return body;
    }

    /** The flyout column is only in the layout while something is open. */
    _syncFlyoutState() {
        const anyOpen = Object.values(this.sectionTabs)
            .some(({ card }) => card.style.display !== "none");
        this.element.classList.toggle("has-open-section", anyOpen);
    }

    _createBrushSection() {
        const body = this._beginSection("Brushes", "brushes", true, "standard");

        const section = document.createElement("div");
        section.className = "sculpt-zpanel-brush-grid";

        const brushes = [
            { id: "standard", label: "Draw", icon: "standard" },
            { id: "smooth", label: "Smooth", icon: "smooth", tip: "Smooth — Ctrl+invert: sharpen" },
            { id: "inflate", label: "Inflate", icon: "inflate" },
            { id: "flatten", label: "Flatten", icon: "flatten", tip: "Flatten — Ctrl+invert: relief" },
            { id: "pinch", label: "Pinch", icon: "pinch" },
            { id: "crease", label: "Crease", icon: "crease" },
            { id: "clay", label: "Clay", icon: "clay" },
            { id: "move", label: "Move", icon: "move" },
            { id: "trim", label: "Trim", icon: "trim", tip: "Trim toward plane — Ctrl+invert side" },
            { id: "snake_hook", label: "Hook", icon: "snake_hook", tip: "SnakeHook — cumulative drag" }
        ];

        for (const brush of brushes) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "sculpt-zpanel-btn";
            btn.dataset.tooltip = brush.tip || brush.label;
            btn.setAttribute("aria-label", `${brush.label} brush`);
            btn.appendChild(this._createIcon(brush.icon));
            btn.onclick = () => {
                this.engine.activeBrush = brush.id;
                this._updateActiveBrush();
                this.onUpdate?.("tool");
            };
            section.appendChild(btn);
            this.brushButtons[brush.id] = btn;
        }

        body.appendChild(section);
        this._updateActiveBrush();
    }

    _createMaterialSection() {
        const body = this._beginSection("Material", "material", false, "material");

        const section = document.createElement("div");
        section.className = "sculpt-zpanel-materials";

        for (const mat of MATERIAL_SWATCHES) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "sculpt-zpanel-swatch";
            btn.dataset.tooltip = mat.label;
            btn.style.background = `rgb(${mat.color[0] * 255},${mat.color[1] * 255},${mat.color[2] * 255})`;
            btn.setAttribute("aria-label", `${mat.label} material`);
            btn.onclick = () => {
                this.engine.baseColor = mat.color;
                this._updateMaterials();
                this.onUpdate?.("render-settings");
            };
            section.appendChild(btn);
            this.matButtons[mat.id] = btn;
        }

        body.appendChild(section);
        this._updateMaterials();
    }

    _createLightingSection() {
        const body = this._beginSection("Light rig", "lightrig", false, "light");

        const section = document.createElement("div");
        section.className = "sculpt-zpanel-lighting";

        for (const rig of LIGHT_RIGS) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "sculpt-zpanel-rig";
            btn.dataset.tooltip = `${rig.label} — ${rig.id.replaceAll("_", " ")}`;
            btn.setAttribute("aria-label", `Lighting ${rig.label}`);
            const preview = document.createElement("div");
            preview.className = "sculpt-zpanel-rig-preview";
            preview.style.background = rig.preview;
            const label = document.createElement("span");
            label.className = "sculpt-zpanel-rig-label";
            label.textContent = rig.label;
            btn.appendChild(preview);
            btn.appendChild(label);
            btn.onclick = () => {
                this.engine.lightingPreset = rig.id;
                this.onUpdate?.("lighting-preset", rig.id);
                this._updateLightingPreset();
            };
            section.appendChild(btn);
            this.lightButtons[rig.id] = btn;
        }

        body.appendChild(section);
        this._updateLightingPreset();
    }

    _createLightControlSection() {
        const body = this._beginSection("Light control", "lightctl", false, "lightControl");

        const box = document.createElement("div");
        box.className = "sculpt-zpanel-light-control";

        const header = document.createElement("div");
        header.className = "sculpt-zpanel-light-header";
        const directionLabel = document.createElement("span");
        directionLabel.textContent = "DIRECTION";
        const readout = document.createElement("span");
        readout.className = "sculpt-zpanel-light-readout";
        header.append(directionLabel, readout);

        const pad = document.createElement("div");
        pad.className = "sculpt-zpanel-light-pad";
        pad.setAttribute("aria-label", "Light direction pad");
        pad.setAttribute("role", "application");
        pad.dataset.tooltip = "Drag to rotate light";

        const knob = document.createElement("div");
        knob.className = "sculpt-zpanel-light-knob";
        pad.appendChild(knob);

        const footer = document.createElement("div");
        footer.className = "sculpt-zpanel-light-footer";

        const powerTrack = document.createElement("div");
        powerTrack.className = "sculpt-zpanel-light-power-track";
        powerTrack.setAttribute("aria-label", "Light power scrub");
        powerTrack.setAttribute("role", "application");
        powerTrack.dataset.tooltip = "Drag left/right or wheel to change power";

        const powerFill = document.createElement("div");
        powerFill.className = "sculpt-zpanel-light-power-fill";

        const powerKnob = document.createElement("div");
        powerKnob.className = "sculpt-zpanel-light-power-knob";

        const powerLabel = document.createElement("div");
        powerLabel.className = "sculpt-zpanel-light-power";

        powerTrack.appendChild(powerFill);
        powerTrack.appendChild(powerKnob);
        powerTrack.appendChild(powerLabel);
        footer.appendChild(powerTrack);

        box.appendChild(header);
        box.appendChild(pad);
        box.appendChild(footer);
        body.appendChild(box);

        const updateDirectionFromClient = (clientX, clientY) => {
            const rect = pad.getBoundingClientRect();
            const nx = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
            const ny = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
            this.engine.lightYaw = nx * 360.0 - 180.0;
            this.engine.lightPitch = (1.0 - ny) * 150.0 - 75.0;
            this._syncLightControls();
            this.onUpdate?.("render-settings");
        };

        const updatePowerFromClient = (clientX) => {
            const rect = powerTrack.getBoundingClientRect();
            const nx = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
            this._setLightPower(nx * 2.0);
        };

        pad.onpointerdown = (e) => {
            this._lightPadPointerId = e.pointerId;
            if (pad.setPointerCapture) {
                try {
                    pad.setPointerCapture(e.pointerId);
                } catch (_) { }
            }
            updateDirectionFromClient(e.clientX, e.clientY);
        };
        pad.onpointermove = (e) => {
            if (this._lightPadPointerId !== e.pointerId) return;
            updateDirectionFromClient(e.clientX, e.clientY);
        };
        pad.onpointerup = (e) => {
            if (this._lightPadPointerId !== e.pointerId) return;
            this._lightPadPointerId = null;
            if (pad.releasePointerCapture) {
                try {
                    pad.releasePointerCapture(e.pointerId);
                } catch (_) { }
            }
        };
        pad.onpointercancel = pad.onpointerup;
        pad.ondblclick = () => {
            this.engine.lightYaw = 0.0;
            this.engine.lightPitch = 0.0;
            this._syncLightControls();
            this.onUpdate?.("render-settings");
        };

        // Keyboard access: arrows steer the light, Home recenters. The visible
        // deg/deg readout doubles as the value announcement target.
        pad.tabIndex = 0;
        pad.setAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight ArrowUp ArrowDown Home");
        pad.onkeydown = (e) => {
            const step = e.shiftKey ? 1 : 8;
            let handled = true;
            if (e.key === "ArrowLeft") this.engine.lightYaw = Math.max(-180, (this.engine.lightYaw ?? 0) - step);
            else if (e.key === "ArrowRight") this.engine.lightYaw = Math.min(180, (this.engine.lightYaw ?? 0) + step);
            else if (e.key === "ArrowUp") this.engine.lightPitch = Math.min(75, (this.engine.lightPitch ?? 0) + step);
            else if (e.key === "ArrowDown") this.engine.lightPitch = Math.max(-75, (this.engine.lightPitch ?? 0) - step);
            else if (e.key === "Home") { this.engine.lightYaw = 0; this.engine.lightPitch = 0; }
            else handled = false;
            if (handled) {
                e.preventDefault();
                this._syncLightControls();
                this.onUpdate?.("render-settings");
            }
        };

        powerTrack.onpointerdown = (e) => {
            this._lightPowerPointerId = e.pointerId;
            if (powerTrack.setPointerCapture) {
                try {
                    powerTrack.setPointerCapture(e.pointerId);
                } catch (_) { }
            }
            updatePowerFromClient(e.clientX);
        };
        powerTrack.onpointermove = (e) => {
            if (this._lightPowerPointerId !== e.pointerId) return;
            updatePowerFromClient(e.clientX);
        };
        powerTrack.onpointerup = (e) => {
            if (this._lightPowerPointerId !== e.pointerId) return;
            this._lightPowerPointerId = null;
            if (powerTrack.releasePointerCapture) {
                try {
                    powerTrack.releasePointerCapture(e.pointerId);
                } catch (_) { }
            }
        };
        powerTrack.onpointercancel = powerTrack.onpointerup;
        powerTrack.onwheel = (e) => {
            e.preventDefault();
            const step = e.shiftKey ? 0.02 : 0.06;
            const dir = e.deltaY < 0 ? 1 : -1;
            this._setLightPower((this.engine.lightPower ?? 1.0) + dir * step);
        };
        powerTrack.ondblclick = () => this._setLightPower(1.0);

        // Keyboard access with proper slider semantics (value synced in
        // _syncLightControls).
        powerTrack.tabIndex = 0;
        powerTrack.setAttribute("role", "slider");
        powerTrack.setAttribute("aria-valuemin", "0");
        powerTrack.setAttribute("aria-valuemax", "2");
        powerTrack.onkeydown = (e) => {
            const step = e.shiftKey ? 0.02 : 0.06;
            const power = this.engine.lightPower ?? 1.0;
            let handled = true;
            if (e.key === "ArrowLeft" || e.key === "ArrowDown") this._setLightPower(power - step);
            else if (e.key === "ArrowRight" || e.key === "ArrowUp") this._setLightPower(power + step);
            else if (e.key === "Home") this._setLightPower(1.0);
            else if (e.key === "End") this._setLightPower(2.0);
            else handled = false;
            if (handled) e.preventDefault();
        };

        this._lightPowerDisplay = powerLabel;
        this._lightYawDisplay = readout;
        this._lightPowerTrack = powerTrack;
        this._lightPowerFill = powerFill;
        this._lightPowerKnob = powerKnob;
        this._lightPad = pad;
        this._lightKnob = knob;
        this._syncLightControls();
    }

    _setLightPower(value) {
        const next = Math.max(0.0, Math.min(2.0, value));
        this.engine.lightPower = Math.round(next * 100) / 100;
        this._syncLightControls();
        this.onUpdate?.("render-settings");
    }

    _syncLightControls() {
        const power = this.engine.lightPower ?? 1.0;
        const yaw = this.engine.lightYaw ?? 0.0;
        const pitch = this.engine.lightPitch ?? 0.0;

        if (this._lightPowerDisplay) {
            this._lightPowerDisplay.textContent = "POWER " + power.toFixed(2);
        }
        if (this._lightYawDisplay) {
            this._lightYawDisplay.textContent = yaw.toFixed(0) + " deg / " + pitch.toFixed(0) + " deg";
        }
        if (this._lightPad && this._lightKnob) {
            const x = ((yaw + 180.0) / 360.0) * 100.0;
            const y = (1.0 - ((pitch + 75.0) / 150.0)) * 100.0;
            this._lightKnob.style.left = Math.max(0, Math.min(100, x)).toFixed(2) + "%";
            this._lightKnob.style.top = Math.max(0, Math.min(100, y)).toFixed(2) + "%";
        }
        if (this._lightPowerFill && this._lightPowerKnob) {
            const pct = Math.max(0, Math.min(100, (power / 2.0) * 100.0));
            this._lightPowerFill.style.width = pct.toFixed(2) + "%";
            this._lightPowerKnob.style.left = pct.toFixed(2) + "%";
        }
        if (this._lightPowerTrack) {
            this._lightPowerTrack.setAttribute("aria-valuenow", power.toFixed(2));
            this._lightPowerTrack.setAttribute("aria-valuetext", `power ${power.toFixed(2)}`);
        }
        if (this._lightPad) {
            this._lightPad.setAttribute(
                "aria-valuetext",
                `yaw ${yaw.toFixed(0)} degrees, pitch ${pitch.toFixed(0)} degrees`
            );
        }
    }

    _createSlider(label, min, max, value, onChange, parent = null) {
        const wrapper = document.createElement("div");
        wrapper.className = "sculpt-zpanel-slider";
        const sliderKind = label.toLowerCase().replace(/\s+/g, "-");
        wrapper.dataset.sliderKind = sliderKind;

        const row = document.createElement("div");
        row.className = "sculpt-zpanel-slider-row";

        const labelText = document.createElement("span");
        labelText.textContent = label.toUpperCase();

        const valueText = document.createElement("span");
        valueText.className = "sculpt-zpanel-slider-value";
        valueText.textContent = Number(value).toFixed(2);

        row.appendChild(labelText);
        row.appendChild(valueText);

        const slider = document.createElement("input");
        slider.className = "sculpt-zpanel-range";
        slider.type = "range";
        slider.min = min;
        slider.max = max;
        slider.step = (max - min) / 60;
        slider.value = value;
        slider.dataset.sliderKind = sliderKind;
        slider.setAttribute("aria-label", `${label} slider`);
        slider.oninput = () => {
            const next = parseFloat(slider.value);
            valueText.textContent = next.toFixed(2);
            this._updateSliderVisual(slider, next);
            onChange(next);
        };
        this._updateSliderVisual(slider, Number(value));

        wrapper.appendChild(row);
        wrapper.appendChild(slider);
        (parent || this.element).appendChild(wrapper);

        if (label === "Radius") {
            this._radiusSlider = slider;
            this._radiusValue = valueText;
        } else if (label === "Strength") {
            this._strengthSlider = slider;
            this._strengthValue = valueText;
        } else if (label === "Gloss") {
            this._glossSlider = slider;
            this._glossValue = valueText;
        }
    }

    _updateSliderVisual(slider, value) {
        const min = parseFloat(slider.min);
        const max = parseFloat(slider.max);
        const clamped = Math.max(min, Math.min(max, value));
        const range = Math.max(1e-6, max - min);
        const pct = ((clamped - min) / range) * 100;
        slider.style.setProperty("--range-progress", `${pct.toFixed(2)}%`);
    }

    _createSymmetrySection() {
        const body = this._beginSection("Symmetry", "symmetry", false, "x");

        const section = document.createElement("div");
        section.className = "sculpt-zpanel-symmetry";

        const axes = [
            { id: "none", label: "Off", icon: "off" },
            { id: "x", label: "X", icon: "x" },
            { id: "y", label: "Y", icon: "y" },
            { id: "z", label: "Z", icon: "z" }
        ];

        for (const axis of axes) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "sculpt-zpanel-btn";
            btn.setAttribute("aria-label", `Symmetry ${axis.label}`);

            const btnContent = document.createElement("div");
            btnContent.style.cssText = "display:flex; flex-direction:column; align-items:center; gap:2px;";
            btnContent.appendChild(this._createIcon(axis.icon));

            const btnText = document.createElement("span");
            btnText.style.fontSize = "8px";
            btnText.textContent = axis.label;
            btnContent.appendChild(btnText);

            btn.appendChild(btnContent);
            btn.onclick = () => {
                this.engine.symmetry = axis.id;
                this._updateSymmetry();
                this.onUpdate?.("tool");
            };
            section.appendChild(btn);
            this.symButtons[axis.id] = btn;
        }

        body.appendChild(section);
        this._updateSymmetry();
    }

    /**
     * Undo/Redo sit directly under the header with no collapsible wrapper:
     * they are the most-used controls and must never be a click away.
     */
    _createQuickBar() {
        const bar = document.createElement("div");
        bar.className = "sculpt-zpanel-quickbar";

        const undoBtn = document.createElement("button");
        undoBtn.type = "button";
        undoBtn.className = "sculpt-zpanel-rail-btn";
        undoBtn.dataset.tooltip = "Undo (Ctrl+Z)";
        undoBtn.setAttribute("aria-label", "Undo sculpt");
        undoBtn.appendChild(this._createIcon("undo"));
        undoBtn.onclick = () => {
            if (this.engine.undo()) {
                this.onUpdate?.("history");
                this._updateUndoRedoButtons();
            }
        };

        const redoBtn = document.createElement("button");
        redoBtn.type = "button";
        redoBtn.className = "sculpt-zpanel-rail-btn";
        redoBtn.dataset.tooltip = "Redo (Ctrl+Y)";
        redoBtn.setAttribute("aria-label", "Redo sculpt");
        redoBtn.appendChild(this._createIcon("redo"));
        redoBtn.onclick = () => {
            if (this.engine.redo()) {
                this.onUpdate?.("history");
                this._updateUndoRedoButtons();
            }
        };

        this.undoButton = undoBtn;
        this.redoButton = redoBtn;

        bar.appendChild(undoBtn);
        bar.appendChild(redoBtn);
        this.rail.appendChild(bar);
        this._updateUndoRedoButtons();
    }

    _createViewImportSection() {
        const body = this._beginSection("View & import", "viewimport", false, "folder");
        const section = document.createElement("div");
        section.className = "sculpt-zpanel-actions";

        const resetBtn = document.createElement("button");
        resetBtn.type = "button";
        resetBtn.className = "sculpt-zpanel-btn";
        resetBtn.appendChild(this._createIcon("reset"));
        resetBtn.appendChild(document.createTextNode("Reset"));
        resetBtn.onclick = () => {
            this.onUpdate?.("reset");
            this._updateUndoRedoButtons();
        };

        const wireBtn = document.createElement("button");
        wireBtn.type = "button";
        wireBtn.className = "sculpt-zpanel-btn";
        wireBtn.appendChild(this._createIcon("wire"));
        wireBtn.appendChild(document.createTextNode("Wire"));
        wireBtn.onclick = () => {
            this.engine.showWireframe = !this.engine.showWireframe;
            this._updateWireframeButton();
            this.onUpdate?.("render");
        };

        const frameBtn = document.createElement("button");
        frameBtn.type = "button";
        frameBtn.className = "sculpt-zpanel-btn";
        frameBtn.textContent = "Frame";
        frameBtn.setAttribute("aria-label", "Frame the whole mesh in the viewport");
        frameBtn.dataset.tooltip = "Recover the mesh in view (Home resets the orbit too)";
        frameBtn.onclick = () => {
            this.engine.frameCamera(false);
            this.onUpdate?.("camera");
        };

        const floorBtn = document.createElement("button");
        floorBtn.type = "button";
        floorBtn.className = "sculpt-zpanel-btn";
        floorBtn.setAttribute("aria-label", "Toggle floor grid");
        floorBtn.appendChild(this._createIcon("floor"));
        floorBtn.appendChild(document.createTextNode("Floor"));
        floorBtn.onclick = () => {
            this.engine.showGrid = !this.engine.showGrid;
            this._updateFloorButton();
            this.onUpdate?.("render");
        };

        this.wireframeButton = wireBtn;
        this.floorButton = floorBtn;

        const hideTexBtn = document.createElement("button");
        hideTexBtn.type = "button";
        hideTexBtn.className = "sculpt-zpanel-btn";
        hideTexBtn.appendChild(document.createTextNode("Hide texture"));
        hideTexBtn.onclick = () => {
            this.engine.showImportedTexture = !this.engine.showImportedTexture;
            this._updateHideTextureButton();
            this.onUpdate?.("render-settings");
        };
        this.hideTextureButton = hideTexBtn;

        const textureBlock = document.createElement("div");
        textureBlock.className = "sculpt-zpanel-texture-block";
        textureBlock.style.display = "none";
        const textureLabel = document.createElement("div");
        textureLabel.className = "sculpt-zpanel-label";
        textureLabel.textContent = "Diffuse map";
        const textureSubLabel = document.createElement("div");
        textureSubLabel.className = "sculpt-zpanel-texture-sublabel";
        textureSubLabel.textContent = "Optional — not an error if empty";
        const textureHintEl = document.createElement("div");
        textureHintEl.className = "sculpt-zpanel-texture-hint";
        textureHintEl.style.display = "none";
        textureBlock.appendChild(textureLabel);
        textureBlock.appendChild(textureSubLabel);
        textureBlock.appendChild(hideTexBtn);
        textureBlock.appendChild(textureHintEl);
        this.textureBlock = textureBlock;
        this.textureHintEl = textureHintEl;

        section.appendChild(resetBtn);
        section.appendChild(frameBtn);
        section.appendChild(wireBtn);
        section.appendChild(floorBtn);
        section.appendChild(textureBlock);

        const loadBtn = document.createElement("button");
        loadBtn.type = "button";
        loadBtn.className = "sculpt-zpanel-btn";
        loadBtn.setAttribute(
            "aria-label",
            "Import one OBJ, FBX, GLB, or glTF mesh. Select companion MTL, BIN, and texture files together, or choose a folder."
        );
        loadBtn.appendChild(this._createIcon("upload"));
        loadBtn.appendChild(document.createTextNode("Load mesh…"));
        loadBtn.style.gridColumn = "1 / -1";

        const importStatus = document.createElement("div");
        importStatus.className = "sculpt-zpanel-import-status";
        importStatus.setAttribute("role", "status");
        importStatus.setAttribute("aria-live", "polite");
        importStatus.hidden = true;
        const setImportStatus = (message, kind = "error") => {
            importStatus.textContent = message;
            importStatus.dataset.kind = kind;
            importStatus.hidden = !message;
            loadBtn.title = message;
        };

        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.multiple = true;
        fileInput.accept =
            ".obj,.fbx,.glb,.gltf,.bin,.mtl,.png,.jpg,.jpeg,.bmp,.webp,.gif,application/octet-stream";
        fileInput.style.display = "none";

        const folderInput = document.createElement("input");
        folderInput.type = "file";
        folderInput.multiple = true;
        folderInput.setAttribute("webkitdirectory", "");
        folderInput.style.display = "none";

        const clearFileInputs = () => {
            fileInput.value = "";
            folderInput.value = "";
        };

        const processMeshFiles = (files) => {
            if (!files.length) return;

            const generation = ++this._importGeneration;
            if (this._activeImportReader?.readyState === FileReader.LOADING) {
                this._activeImportReader.abort();
            }
            this._activeImportReader = null;
            const isCurrent = () => !this._destroyed && generation === this._importGeneration;

            const selection = selectMeshImport(files);
            if (selection.error === "no-mesh") {
                setImportStatus("Select at least one .obj, .fbx, .glb, or .gltf file.");
                clearFileInputs();
                return;
            }
            if (selection.error === "multiple-meshes") {
                console.error(
                    "Sculpt: import selection contains multiple mesh files; select one mesh and its companion files:",
                    selection.meshFiles.map((file) => file.name)
                );
                setImportStatus("Select exactly one mesh file at a time.");
                clearFileInputs();
                return;
            }
            if (selection.error === "mesh-too-large") {
                console.error(
                    `Sculpt: mesh file too large (${formatMiB(selection.meshFile.size)}, max ${formatMiB(MAX_MESH_FILE_BYTES)}):`,
                    selection.meshFile.name
                );
                setImportStatus(`Mesh file too large (max ${formatMiB(MAX_MESH_FILE_BYTES)}).`);
                clearFileInputs();
                return;
            }

            const { meshFile, kind, companionFiles, skippedCompanions } = selection;
            const isFbx = kind === "fbx";
            const isGlb = kind === "glb";
            const isGltf = kind === "gltf";

            if (skippedCompanions > 0) {
                console.warn(
                    `Sculpt: skipped ${skippedCompanions} companion file(s) over the import budget ` +
                    `(per-file max ${formatMiB(MAX_COMPANION_FILE_BYTES)}, ` +
                    `max ${MAX_COMPANION_FILES} files, total ${formatMiB(MAX_TOTAL_IMPORT_BYTES)}). ` +
                    "Textures may be missing on the imported mesh."
                );
                setImportStatus(
                    "Some companion files were skipped because the import budget was exceeded.",
                    "warning"
                );
            }

            const reader = new FileReader();
            this._activeImportReader = reader;
            reader.onerror = () => {
                if (!isCurrent()) return;
                console.error("Sculpt: file read failed:", meshFile.name, reader.error);
                setImportStatus("The mesh file could not be read.");
                this._activeImportReader = null;
            };
            reader.onload = (ev) => {
                if (!isCurrent()) return;
                this._activeImportReader = null;
                const run = async () => {
                    if (!isCurrent()) return;
                    let ok = false;
                    try {
                        const shouldApply = isCurrent;
                        if (isFbx) {
                            const buf = ev.target.result;
                            if (!(buf instanceof ArrayBuffer)) {
                                throw new Error("Expected ArrayBuffer for FBX");
                            }
                            ok = await this.engine.loadFromFBXBuffer(buf, { textureFiles: companionFiles, shouldApply });
                        } else if (isGlb) {
                            const buf = ev.target.result;
                            if (!(buf instanceof ArrayBuffer)) {
                                throw new Error("Expected ArrayBuffer for GLB");
                            }
                            ok = await this.engine.loadFromGLTFData(buf, { companionFiles, shouldApply });
                        } else if (isGltf) {
                            if (typeof ev.target.result !== "string") {
                                throw new Error("Expected text for glTF JSON");
                            }
                            ok = await this.engine.loadFromGLTFData(ev.target.result, { companionFiles, shouldApply });
                        } else {
                            if (typeof ev.target.result !== "string") {
                                throw new Error("Expected text for OBJ");
                            }
                            if (companionFiles.size > 0) {
                                ok = await this.engine.loadFromOBJData(ev.target.result, { companionFiles, shouldApply });
                            } else {
                                if (isCurrent()) ok = this.engine.loadFromOBJ(ev.target.result);
                            }
                        }
                        if (!isCurrent()) return;
                        if (ok) {
                            setImportStatus(`${meshFile.name} imported.`, "success");
                            this.onUpdate?.("mesh-loaded");
                            this._updateUndoRedoButtons();
                        } else {
                            console.error("Sculpt: mesh import returned false:", meshFile.name);
                            setImportStatus(
                                "Mesh import failed. Check that the mesh and companion files are valid."
                            );
                        }
                    } catch (err) {
                        if (!isCurrent()) return;
                        console.error("Sculpt: mesh import error:", meshFile.name, err);
                        setImportStatus(
                            "Mesh import failed. Check that the mesh and companion files are valid."
                        );
                    } finally {
                        if (isCurrent()) clearFileInputs();
                    }
                };
                // Keep parser work serialized to avoid overlapping large decodes.
                // Generation guards guarantee that stale parses cannot apply.
                this._importChain = (this._importChain || Promise.resolve())
                    .catch(() => { })
                    .then(run);
            };
            if (isFbx || isGlb) {
                reader.readAsArrayBuffer(meshFile);
            } else {
                reader.readAsText(meshFile);
            }
        };

        fileInput.onchange = (e) => {
            processMeshFiles(Array.from(e.target.files || []));
        };
        folderInput.onchange = (e) => {
            processMeshFiles(Array.from(e.target.files || []));
        };

        const folderBtn = document.createElement("button");
        folderBtn.type = "button";
        folderBtn.className = "sculpt-zpanel-btn";
        folderBtn.setAttribute(
            "aria-label",
            "Choose a folder that contains the mesh and texture files (useful for FBX with external PNG or JPG)."
        );
        folderBtn.appendChild(this._createIcon("folder"));
        folderBtn.appendChild(document.createTextNode("Load folder…"));
        folderBtn.style.gridColumn = "1 / -1";

        loadBtn.onclick = () => fileInput.click();
        folderBtn.onclick = () => folderInput.click();

        section.appendChild(loadBtn);
        section.appendChild(folderBtn);
        section.appendChild(importStatus);
        section.appendChild(fileInput);
        section.appendChild(folderInput);

        body.appendChild(section);
        this._updateWireframeButton();
        this._updateFloorButton();
        this._updateHideTextureButton();
        this._updateUndoRedoButtons();
    }

    /**
     * Parsing as image/svg+xml is a strict XML parse: namespaces come only from
     * an explicit xmlns. Without it the root is a namespace-less Element that
     * takes up its CSS box but draws nothing, a silently blank button. This
     * check makes an icon added without xmlns fail visibly instead.
     */
    /**
     * Queue-time and export settings. These drive hidden classic widgets on the
     * node (see NodeUI PANEL_WIDGETS), so the values still save with the
     * workflow and reach the backend like any other input.
     */
    _createExportSection() {
        const body = this._beginSection("Export", "export", false, "export");
        this._createChoiceRow(body, "Preview background", "preview_background", [
            { value: "viewport", label: "Viewport", tip: "Gradient background like the canvas" },
            { value: "transparent", label: "Alpha", tip: "Transparent background" }
        ], "viewport");
        this._createChoiceRow(body, "Preview size", "preview_size", [
            { value: 256, label: "256" },
            { value: 512, label: "512" },
            { value: 1024, label: "1024" },
            { value: 2048, label: "2048" }
        ], 512);
        const exportChoice = {
            none: { label: "Off", tip: "Only the mesh_obj text output" },
            obj: { label: "OBJ", tip: "OBJ with MTL and PNG when textured" },
            glb: { label: "GLB", tip: "glTF binary, texture embedded" },
            stl: { label: "STL", tip: "Binary STL, geometry only" }
        };
        this._createChoiceRow(body, "Write file", "export_format", EXPORT_FORMATS.map((value) => ({
            value,
            label: exportChoice[value]?.label ?? value.toUpperCase(),
            tip: exportChoice[value]?.tip
        })), "none");

        const label = document.createElement("div");
        label.className = "sculpt-zpanel-label";
        label.textContent = "File name";
        const input = document.createElement("input");
        input.type = "text";
        input.className = "sculpt-zpanel-text";
        input.spellcheck = false;
        input.setAttribute("aria-label", "Export file name prefix");
        input.dataset.tooltip = "Prefix inside the ComfyUI output folder, like Save Image";
        const current = () => String(this.getExportSetting?.("filename_prefix") ?? "sculpt");
        input.value = current();
        input.onchange = () => {
            const value = input.value.trim() || "sculpt";
            input.value = value;
            this.setExportSetting?.("filename_prefix", value);
        };
        this._exportSyncers.push(() => { input.value = current(); });
        body.append(label, input);
    }

    _createChoiceRow(body, labelText, name, choices, fallback) {
        const label = document.createElement("div");
        label.className = "sculpt-zpanel-label";
        label.textContent = labelText;
        const group = document.createElement("div");
        group.className = "sculpt-zpanel-segmented";
        const buttons = {};
        const current = () => String(this.getExportSetting?.(name) ?? fallback);
        const sync = () => {
            const value = current();
            for (const choice of choices) {
                this._setPressed(buttons[choice.value], String(choice.value) === value);
            }
        };
        for (const choice of choices) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "sculpt-zpanel-btn sculpt-zpanel-seg-btn";
            btn.textContent = choice.label;
            if (choice.tip) btn.dataset.tooltip = choice.tip;
            btn.onclick = () => {
                this.setExportSetting?.(name, choice.value);
                sync();
            };
            buttons[choice.value] = btn;
            group.appendChild(btn);
        }
        body.append(label, group);
        sync();
        this._exportSyncers.push(sync);
    }

    _createIcon(name) {
        const wrap = document.createElement("span");
        wrap.className = "sculpt-zpanel-icon";
        const parsed = new DOMParser().parseFromString(
            ICONS[name] || ICONS.standard,
            "image/svg+xml"
        );
        const root = parsed.documentElement;
        if (root.namespaceURI !== SVG_NAMESPACE || root.localName !== "svg") {
            console.error(
                `Sculpt: icon "${name}" did not parse as SVG (namespace `
                + `${root.namespaceURI}); it needs xmlns="${SVG_NAMESPACE}".`
            );
            return wrap;
        }
        const icon = document.importNode(root, true);
        icon.setAttribute("aria-hidden", "true");
        icon.setAttribute("focusable", "false");
        wrap.appendChild(icon);
        return wrap;
    }

    /**
     * Hover and focus hints for anything carrying data-tooltip.
     *
     * A single fixed-position node on document.body rather than a ::before on
     * each control: the panel scrolls and section bodies clip, which truncates
     * an in-panel tooltip at the panel edge. Positioning here also lets the
     * hint flip sides near the viewport edge instead of running off-screen.
     */
    _installTooltips() {
        this._tipEl = null;

        this._showTip = (target) => {
            const text = target?.dataset?.tooltip;
            if (!text) return;
            if (!this._tipEl) {
                this._tipEl = document.createElement("div");
                this._tipEl.className = "sculpt-zpanel-tip";
                this._tipEl.setAttribute("role", "tooltip");
                document.body.appendChild(this._tipEl);
            }
            const tip = this._tipEl;
            tip.textContent = text;
            tip.classList.add("is-visible");

            const anchor = target.getBoundingClientRect();
            const box = tip.getBoundingClientRect();
            const gap = 8;
            const margin = 4;

            let left = anchor.right + gap;
            if (left + box.width > window.innerWidth - margin) {
                left = anchor.left - gap - box.width;
            }
            left = Math.max(margin, Math.min(left, window.innerWidth - box.width - margin));

            let top = anchor.top + anchor.height / 2 - box.height / 2;
            top = Math.max(margin, Math.min(top, window.innerHeight - box.height - margin));

            tip.style.left = `${Math.round(left)}px`;
            tip.style.top = `${Math.round(top)}px`;
        };

        this._hideTip = () => this._tipEl?.classList.remove("is-visible");

        this._onTipEnter = (event) => {
            const target = event.target?.closest?.("[data-tooltip]");
            if (target) this._showTip(target);
            else this._hideTip();
        };

        this._onTipLeave = (event) => {
            const target = event.target?.closest?.("[data-tooltip]");
            if (!target) return;
            if (event.relatedTarget && target.contains(event.relatedTarget)) return;
            this._hideTip();
        };

        this.element.addEventListener("pointerover", this._onTipEnter);
        this.element.addEventListener("pointerout", this._onTipLeave);
        this.element.addEventListener("focusin", this._onTipEnter);
        this.element.addEventListener("focusout", this._hideTip);
        // A press means the user already knows what the control is.
        this.element.addEventListener("pointerdown", this._hideTip);
        this.element.addEventListener("scroll", this._hideTip, true);
    }

    _removeTooltips() {
        if (!this.element) return;
        this.element.removeEventListener("pointerover", this._onTipEnter);
        this.element.removeEventListener("pointerout", this._onTipLeave);
        this.element.removeEventListener("focusin", this._onTipEnter);
        this.element.removeEventListener("focusout", this._hideTip);
        this.element.removeEventListener("pointerdown", this._hideTip);
        this.element.removeEventListener("scroll", this._hideTip, true);
        this._tipEl?.remove();
        this._tipEl = null;
    }

    _setPressed(button, pressed) {
        if (!button) return;
        button.classList.toggle("is-active", !!pressed);
        button.setAttribute("aria-pressed", String(!!pressed));
    }

    _updateActiveBrush() {
        for (const id of Object.keys(this.brushButtons)) {
            const btn = this.brushButtons[id];
            this._setPressed(btn, id === this.engine.activeBrush);
        }
    }

    _updateMaterials() {
        const active = this.engine.baseColor || [0.38, 0.08, 0.02];

        for (const swatch of MATERIAL_SWATCHES) {
            const btn = this.matButtons[swatch.id];
            if (!btn) continue;
            const c = swatch.color;
            const match = Math.abs(c[0] - active[0]) < 0.01
                && Math.abs(c[1] - active[1]) < 0.01
                && Math.abs(c[2] - active[2]) < 0.01;
            this._setPressed(btn, match);
        }
    }

    _updateLightingPreset() {
        const active = this.engine.lightingPreset || "zbrush_red_wax";
        for (const id of Object.keys(this.lightButtons)) {
            this._setPressed(this.lightButtons[id], id === active);
        }
    }

    _updateSymmetry() {
        for (const id of Object.keys(this.symButtons)) {
            const btn = this.symButtons[id];
            this._setPressed(btn, id === this.engine.symmetry);
        }
    }

    _updateWireframeButton() {
        if (!this.wireframeButton) return;
        this._setPressed(this.wireframeButton, !!this.engine.showWireframe);
    }

    _updateFloorButton() {
        if (!this.floorButton) return;
        this._setPressed(this.floorButton, !!this.engine.showGrid);
    }

    _updateHideTextureButton() {
        if (!this.hideTextureButton || !this.textureBlock || !this.textureHintEl) return;
        const kind = this.engine.lastMeshImportKind;
        if (!kind) {
            this.textureBlock.style.display = "none";
            return;
        }
        this.textureBlock.style.display = "";

        const vc = this.engine.mesh?.vertexCount || 0;
        const hasUvs = this.engine.mesh?.uvs?.length === vc * 2;
        const hasDiffuse = !!this.engine.importedDiffuseImage;
        const canPaintTexture = hasDiffuse && hasUvs;

        if (canPaintTexture) {
            this.hideTextureButton.style.display = "";
            this.textureHintEl.style.display = "none";
            this.hideTextureButton.disabled = false;
            this.hideTextureButton.textContent = this.engine.showImportedTexture ? "Hide texture" : "Show texture";
            this._setPressed(this.hideTextureButton, !this.engine.showImportedTexture);
            this.hideTextureButton.dataset.tooltip = "Toggle imported diffuse texture vs sculpt material";
        } else {
            this.hideTextureButton.style.display = "none";
            this.textureHintEl.style.display = "";
            this.hideTextureButton.classList.remove("is-active");
            this.hideTextureButton.setAttribute("aria-pressed", "false");
            if (!hasUvs) {
                this.textureHintEl.textContent =
                    "Info. This mesh has no UVs, so no image can be mapped. The sculpt material (Red Wax, etc.) is used.";
            } else if (kind === "obj") {
                this.textureHintEl.textContent =
                    "Info. This OBJ path does not load MTL/images. Use .glb with embedded textures, or pick a swatch under Light rig.";
            } else if (kind === "fbx") {
                this.textureHintEl.textContent =
                    "Info. No embedded diffuse in this FBX. Use Load folder on the folder that contains the FBX and images, or Load mesh and Ctrl+click the FBX plus its PNG/JPG files.";
            } else {
                this.textureHintEl.textContent =
                    "Info. No texture bitmap was found in this file. Use Load folder on the folder that contains the glTF/GLB and its companion files (.bin, images), or use .glb with embedded textures.";
            }
        }
    }

    _updateUndoRedoButtons() {
        if (this.undoButton) this.undoButton.disabled = !this.engine?.canUndo?.();
        if (this.redoButton) this.redoButton.disabled = !this.engine?.canRedo?.();
    }
    /**
     * Update UI from shortcuts or external changes
     */
    refresh() {
        this._updateActiveBrush();
        this._updateStrokeModeButtons();
        this._updateMaskModeButton();
        this._updateSymmetry();
        this._updateMaterials();
        this._updateLightingPreset();
        this._updateWireframeButton();
        this._updateFloorButton();
        this._updateHideTextureButton();
        this._updateUndoRedoButtons();

        if (this._radiusSlider && this._radiusValue) {
            this._radiusSlider.value = this.engine.brushRadius;
            this._radiusValue.textContent = this.engine.brushRadius.toFixed(2);
            this._updateSliderVisual(this._radiusSlider, this.engine.brushRadius);
        }
        if (this._strengthSlider && this._strengthValue) {
            this._strengthSlider.value = this.engine.brushStrength;
            this._strengthValue.textContent = this.engine.brushStrength.toFixed(2);
            this._updateSliderVisual(this._strengthSlider, this.engine.brushStrength);
        }
        if (this._glossSlider && this._glossValue) {
            const gloss = this.engine.matcapIntensity ?? 1.0;
            this._glossSlider.value = gloss;
            this._glossValue.textContent = gloss.toFixed(2);
            this._updateSliderVisual(this._glossSlider, gloss);
        }
        this._syncLightControls();
        this.syncSettings();
    }

    /**
     * Re-read the hidden settings widgets into the Mesh and Export rows. The
     * rows only know about their own clicks, so anything else that writes a
     * widget (a widget-driven reload, the API, a future caller) goes through
     * here, and refresh() runs it on every state change.
     */
    syncSettings() {
        for (const sync of this._exportSyncers) sync();
    }

    destroy() {
        this._destroyed = true;
        this._importGeneration++;
        if (this._activeImportReader?.readyState === FileReader.LOADING) {
            this._activeImportReader.abort();
        }
        if (this._activeImportReader) {
            this._activeImportReader.onload = null;
            this._activeImportReader.onerror = null;
        }
        this._activeImportReader = null;
        this._removeTooltips();
        if (this.element && this.element.parentNode) {
            this.element.parentNode.removeChild(this.element);
        }

        this.brushButtons = {};
        this.matButtons = {};
        this.lightButtons = {};
        this.symButtons = {};
        this.strokeModeButtons = {};
        this.maskPaintButton = null;
        this.wireframeButton = null;
        this.floorButton = null;
        this.hideTextureButton = null;
        this.textureBlock = null;
        this.textureHintEl = null;
        this.undoButton = null;
        this.redoButton = null;
        this._radiusSlider = null;
        this._radiusValue = null;
        this._strengthSlider = null;
        this._strengthValue = null;
        this._glossSlider = null;
        this._glossValue = null;
        if (this._lightPad) {
            this._lightPad.onpointerdown = null;
            this._lightPad.onpointermove = null;
            this._lightPad.onpointerup = null;
            this._lightPad.onpointercancel = null;
            this._lightPad.ondblclick = null;
            this._lightPad.onkeydown = null;
        }
        if (this._lightPowerTrack) {
            this._lightPowerTrack.onpointerdown = null;
            this._lightPowerTrack.onpointermove = null;
            this._lightPowerTrack.onpointerup = null;
            this._lightPowerTrack.onpointercancel = null;
            this._lightPowerTrack.onwheel = null;
            this._lightPowerTrack.ondblclick = null;
            this._lightPowerTrack.onkeydown = null;
        }
        this._lightPowerDisplay = null;
        this._lightYawDisplay = null;
        this._lightPowerTrack = null;
        this._lightPowerFill = null;
        this._lightPowerKnob = null;
        this._lightPad = null;
        this._lightKnob = null;
        this._lightPadPointerId = null;
        this._lightPowerPointerId = null;
        this._exportSyncers = [];
        this.onPresetSelect = null;
        this.getExportSetting = null;
        this.setExportSetting = null;
        this.onUpdate = null;
        this.engine = null;
        this.container = null;
        this.element = null;
    }
}
