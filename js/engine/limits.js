/**
 * Frontend mesh limits. This is the cross-language contract.
 *
 * MAX_IMPORT_VERTEX_COUNT must equal MAX_MESH_VERTICES in nodes.py: the
 * backend rejects denser meshes at queue time, so importing more in the
 * viewport would be a dead end. Both test suites (tests/primitiveParity.test.js
 * and tests/test_primitive_parity.py) fail if the two sides ever diverge.
 */

export const MAX_IMPORT_VERTEX_COUNT = 300000;
export const MAX_MESH_FACE_INDICES = 2000000;
export const MAX_SCULPT_DATA_BYTES = 52428800;

// Meshes above this embed a server-side _meshRef instead of inline JSON.
// About 1 MB of JSON: the frontend keeps workflow drafts in localStorage,
// whose ~5 MB quota is shared by every open workflow.
export const MAX_WIDGET_EMBED_VERTICES = 12000;
export const MAX_WIDGET_EMBED_FACE_INDICES = 72000;

/** Preview image size bounds; PREVIEW_SIZE_* in nodes.py must match. */
export const PREVIEW_SIZE_MIN = 128;
export const PREVIEW_SIZE_MAX = 2048;
export const PREVIEW_SIZE_DEFAULT = 512;

/** Export formats the backend writes; EXPORT_FORMATS in nodes.py must match. */
export const EXPORT_FORMATS = ["none", "obj", "glb", "stl"];

/** Starting shapes and density range; PRIMITIVE_TYPES and SUBDIVISION_* in nodes.py must match. */
export const PRIMITIVE_TYPES = ["sphere", "cube", "cylinder", "torus", "plane"];
export const SUBDIVISION_MIN = 1;
export const SUBDIVISION_MAX = 5;
