/**
 * Choose the _sculpt_data value for a workflow save. LiteGraph serializes
 * synchronously, so there is no chance to await an upload here: when the stub
 * omits geometry but the current revision is not yet stored server-side, embed
 * the full mesh rather than write a stub whose ref would not resolve on reload.
 * `needsUpload` tells the caller to still push the mesh to the store afterwards.
 *
 * `futurePayload` wins over everything else: a payload written by a newer schema
 * version than this build understands is passed through byte-for-byte so that
 * re-saving an unsupported workflow never downgrades it.
 */
import { PREVIEW_SIZE_DEFAULT, PREVIEW_SIZE_MAX, PREVIEW_SIZE_MIN } from "../engine/limits.js";

/** Value of a named widget on a graph node, or `fallback` when absent. */
export function readWidgetValue(node, name, fallback) {
    const w = node?.widgets?.find?.((x) => x?.name === name);
    return w && w.value !== undefined && w.value !== null ? w.value : fallback;
}

/** preview_size widget as a clamped integer; bad or missing values use the default. */
export function readPreviewSize(node) {
    const raw = Number(readWidgetValue(node, "preview_size", PREVIEW_SIZE_DEFAULT));
    if (!Number.isFinite(raw)) return PREVIEW_SIZE_DEFAULT;
    return Math.max(PREVIEW_SIZE_MIN, Math.min(PREVIEW_SIZE_MAX, Math.round(raw)));
}

export function chooseWorkflowSculptValue({
    widgetValue,
    futurePayload,
    pendingRestore,
    widgetData,
    isCurrentRevisionStored
}) {
    if (futurePayload) {
        return { value: futurePayload, needsUpload: false };
    }
    if (pendingRestore || !widgetData?._meshOmittedFromWorkflow) {
        return { value: widgetValue, needsUpload: false };
    }
    // Upload still pending: keep the stub and push the upload. Embedding the
    // geometry here would put megabytes into every draft the frontend autosaves.
    return { value: widgetValue, needsUpload: !isCurrentRevisionStored };
}
