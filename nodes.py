"""
SculptCanvas node - interactive mesh sculpting in ComfyUI
"""

import base64
import hashlib
import io
import json
import math
import os
import re
import struct
import numpy as np
import torch

MAX_SCULPT_DATA_BYTES = 52_428_800
MAX_MESH_VERTICES = 300_000
MAX_MESH_FACE_INDICES = 2_000_000
MAX_ABS_COORDINATE = 1_000_000.0
PREVIEW_MAX_VERTICES = 120_000
PREVIEW_MAX_CPU_TRIANGLES = 56_000
PREVIEW_MAX_RASTER_PIXELS = 16_777_216
PREVIEW_CAPTURE_MAX_PIXELS = 16_777_216
PREVIEW_CAPTURE_MAX_BYTES = 24_000_000
# Both the browser capture (max edge) and the CPU fallback (square) use this.
PREVIEW_SIZE_MIN = 128
PREVIEW_SIZE_MAX = 2048
PREVIEW_SIZE_DEFAULT = 512
EXPORT_FORMATS = ("none", "obj", "glb", "stl")
# Diffuse atlas uploaded by the frontend for textured exports (PNG only).
MAX_TEXTURE_BYTES = 33_554_432
MAX_TEXTURE_PIXELS = 16_777_216

PRIMITIVE_TYPES = ("sphere", "cube", "cylinder", "torus", "plane")
PREVIEW_BACKGROUNDS = ("viewport", "transparent")
SUBDIVISION_MIN = 1
SUBDIVISION_MAX = 5

# Characters that cannot appear in a file name on every platform ComfyUI runs on.
FILENAME_FORBIDDEN_RE = re.compile(r'[<>:"|?*\x00-\x1f]')

# Content-addressed reference to a mesh stored server-side (sha256 hex).
MESH_REF_RE = re.compile(r"^[0-9a-f]{16,64}$")


def _mesh_store_dir(create=False):
    """Directory where large meshes are persisted, or None outside a ComfyUI runtime."""
    try:
        import folder_paths
    except ImportError:
        return None
    base = os.path.join(folder_paths.get_user_directory(), "sculpt", "meshes")
    if create:
        os.makedirs(base, exist_ok=True)
    return base


def _load_mesh_ref(ref):
    """Load a stored mesh payload by reference. Returns a dict or None."""
    if not isinstance(ref, str) or not MESH_REF_RE.fullmatch(ref):
        return None
    base = _mesh_store_dir()
    if base is None:
        return None
    path = os.path.join(base, f"{ref}.json")
    try:
        if not os.path.isfile(path) or os.path.getsize(path) > MAX_SCULPT_DATA_BYTES:
            return None
        with open(path, "rb") as f:
            raw = f.read(MAX_SCULPT_DATA_BYTES + 1)
        if len(raw) > MAX_SCULPT_DATA_BYTES:
            return None
        # The ref is the content hash, so verify it before trusting the store.
        # Legacy refs are truncated digests: comparing as a prefix keeps them
        # readable while still rejecting a file whose contents no longer match.
        if not hashlib.sha256(raw).hexdigest().startswith(ref):
            return None
        data = json.loads(raw)
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _extract_mesh_payload(data):
    """Return (vertices, faces) when a mesh payload is present, or None when absent.

    Raises ValueError when a payload is present but malformed. Validation and
    execution share this single implementation so they cannot disagree on what
    counts as a valid mesh.
    """
    if not isinstance(data, dict):
        return None

    _validate_sculpt_state(data)

    vertices = data.get("vertices")
    faces = data.get("faces")
    empty_vertices = vertices is None or (isinstance(vertices, list) and len(vertices) == 0)
    if data.get("_meshOmittedFromWorkflow") is True and empty_vertices:
        return None
    if vertices is None and faces is None:
        return None
    if not isinstance(vertices, list) or not isinstance(faces, list):
        raise ValueError("'vertices' and 'faces' must both be JSON arrays")
    if len(vertices) == 0 and len(faces) == 0:
        return None
    if len(vertices) < 9 or len(vertices) % 3 != 0:
        raise ValueError("'vertices' length must be a multiple of 3 and at least 9")
    if len(vertices) > MAX_MESH_VERTICES * 3:
        raise ValueError(f"too many vertex scalars (max {MAX_MESH_VERTICES * 3})")
    if len(faces) < 3 or len(faces) % 3 != 0:
        raise ValueError("'faces' length must be a multiple of 3 (triangles)")
    if len(faces) > MAX_MESH_FACE_INDICES:
        raise ValueError(f"too many face indices (max {MAX_MESH_FACE_INDICES})")

    clean_vertices = []
    for value in vertices:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("vertex values must be numbers")
        value = float(value)
        if not math.isfinite(value):
            raise ValueError("vertex values must be finite")
        if abs(value) > MAX_ABS_COORDINATE:
            raise ValueError(
                f"vertex values must be within +/-{MAX_ABS_COORDINATE:g}"
            )
        clean_vertices.append(value)

    vertex_count = len(clean_vertices) // 3
    clean_faces = []
    for value in faces:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("face indices must be numbers")
        if isinstance(value, float) and not value.is_integer():
            raise ValueError("face indices must be integers")
        index = int(value)
        if index < 0 or index >= vertex_count:
            raise ValueError(f"face index {index} out of range (vertex count {vertex_count})")
        clean_faces.append(index)

    uvs = data.get("uvs")
    if uvs is not None:
        if not isinstance(uvs, list):
            raise ValueError("'uvs' must be a JSON array")
        if len(uvs) != vertex_count * 2:
            raise ValueError(
                f"'uvs' length must be twice the vertex count ({len(uvs)} != {vertex_count * 2})"
            )
        for value in uvs:
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(float(value))
                or abs(float(value)) > MAX_ABS_COORDINATE
            ):
                raise ValueError(
                    f"'uvs' values must be finite numbers within +/-{MAX_ABS_COORDINATE:g}"
                )

    vertex_owners = data.get("vertexOwners")
    if vertex_owners is not None:
        if not isinstance(vertex_owners, list):
            raise ValueError("'vertexOwners' must be a JSON array")
        if len(vertex_owners) != vertex_count:
            raise ValueError(
                "'vertexOwners' length must match the vertex count "
                f"({len(vertex_owners)} != {vertex_count})"
            )
        for value in vertex_owners:
            if (
                isinstance(value, bool)
                or not isinstance(value, int)
                or value < 0
                or value > 0xFFFFFFFF
            ):
                raise ValueError("'vertexOwners' values must be unsigned integers")

    vertex_mask = data.get("vertexMask")
    if vertex_mask is not None:
        if not isinstance(vertex_mask, list):
            raise ValueError("'vertexMask' must be a JSON array")
        if len(vertex_mask) != vertex_count:
            raise ValueError(
                f"'vertexMask' length must match vertex count ({len(vertex_mask)} != {vertex_count})"
            )
        for value in vertex_mask:
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(float(value))
                or not 0.0 <= float(value) <= 1.0
            ):
                raise ValueError("'vertexMask' values must be finite numbers between 0 and 1")

    return clean_vertices, clean_faces


def _validate_sculpt_state(data):
    """Validate optional persisted render state without rejecting future fields."""
    base_color = data.get("baseColor")
    if base_color is not None:
        if not isinstance(base_color, list) or len(base_color) < 3:
            raise ValueError("'baseColor' must be an RGB array")
        for value in base_color[:3]:
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(float(value))
                or not 0.0 <= float(value) <= 1.0
            ):
                raise ValueError("'baseColor' values must be finite numbers between 0 and 1")

    camera = data.get("camera")
    if camera is None:
        return
    if not isinstance(camera, dict):
        raise ValueError("'camera' must be a JSON object")

    defaults = {
        "distance": 3.0,
        "theta": math.pi / 4.0,
        "phi": math.pi / 6.0,
        "fov": 45.0,
        "near": 0.1,
        "far": 100.0,
    }
    values = {}
    for key, default in defaults.items():
        raw = camera.get(key, default)
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            raise ValueError(f"camera '{key}' must be a number")
        value = float(raw)
        if not math.isfinite(value):
            raise ValueError(f"camera '{key}' must be finite")
        values[key] = value
    if values["distance"] <= 0:
        raise ValueError("camera 'distance' must be greater than zero")
    if values["distance"] > MAX_ABS_COORDINATE:
        raise ValueError(
            f"camera 'distance' must be at most {MAX_ABS_COORDINATE:g}"
        )
    if not 1.0 <= values["fov"] < 179.0:
        raise ValueError("camera 'fov' must be between 1 and 179 degrees")
    if values["near"] <= 0:
        raise ValueError("camera 'near' must be greater than zero")
    if values["far"] <= values["near"]:
        raise ValueError("camera 'far' must be greater than 'near'")
    if values["near"] > MAX_ABS_COORDINATE or values["far"] > MAX_ABS_COORDINATE:
        raise ValueError(
            f"camera clipping planes must be at most {MAX_ABS_COORDINATE:g}"
        )

    target = camera.get("target")
    if target is not None:
        if not isinstance(target, list) or len(target) < 3:
            raise ValueError("camera 'target' must be an XYZ array")
        for value in target[:3]:
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(float(value))
                or abs(float(value)) > MAX_ABS_COORDINATE
            ):
                raise ValueError(
                    f"camera 'target' values must be finite numbers within "
                    f"+/-{MAX_ABS_COORDINATE:g}"
                )


def _texture_store_dir(create=False):
    """Directory holding uploaded diffuse atlases, or None outside ComfyUI."""
    try:
        import folder_paths
    except ImportError:
        return None
    base = os.path.join(folder_paths.get_user_directory(), "sculpt", "textures")
    if create:
        os.makedirs(base, exist_ok=True)
    return base


def _validate_png_bytes(raw):
    """Return (width, height) for a decodable PNG within limits, else None."""
    if not isinstance(raw, (bytes, bytearray)) or len(raw) > MAX_TEXTURE_BYTES:
        return None
    if bytes(raw[:8]) != b"\x89PNG\r\n\x1a\n":
        return None
    try:
        from PIL import Image
        with Image.open(io.BytesIO(raw)) as img:
            width, height = img.size
            if width <= 0 or height <= 0 or width * height > MAX_TEXTURE_PIXELS:
                return None
            img.verify()
        return width, height
    except Exception:
        return None


def _load_texture_ref(ref):
    """Load an uploaded PNG by content hash. Returns bytes or None."""
    if not isinstance(ref, str) or not MESH_REF_RE.fullmatch(ref):
        return None
    base = _texture_store_dir()
    if base is None:
        return None
    path = os.path.join(base, f"{ref}.png")
    try:
        if not os.path.isfile(path) or os.path.getsize(path) > MAX_TEXTURE_BYTES:
            return None
        with open(path, "rb") as f:
            raw = f.read(MAX_TEXTURE_BYTES + 1)
    except OSError:
        return None
    if len(raw) > MAX_TEXTURE_BYTES:
        return None
    if not hashlib.sha256(raw).hexdigest().startswith(ref):
        return None
    if _validate_png_bytes(raw) is None:
        return None
    return bytes(raw)


def _extract_uvs(data, vertex_count):
    """Per-vertex UVs as a flat float list, or None. Assumes a validated payload."""
    if not isinstance(data, dict):
        return None
    uvs = data.get("uvs")
    if not isinstance(uvs, list) or len(uvs) != vertex_count * 2:
        return None
    return [float(v) for v in uvs]


def _smooth_normals(v, f):
    """Area-weighted vertex normals for (N,3) float vertices and (M,3) int faces."""
    normals = np.zeros_like(v)
    v0, v1, v2 = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    face_normals = np.cross(v1 - v0, v2 - v0)
    for i in range(3):
        np.add.at(normals, f[:, i], face_normals)
    norm = np.linalg.norm(normals, axis=1, keepdims=True)
    return np.divide(normals, norm, out=np.zeros_like(normals), where=norm > 0)


def _srgb_to_linear(value):
    """sRGB to linear; MTL Kd and glTF baseColorFactor are linear."""
    v = min(1.0, max(0.0, float(value)))
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def _export_color(base_color):
    """Base colour as files store it: linear."""
    bc = base_color if base_color is not None else [0.7, 0.65, 0.6]
    return [_srgb_to_linear(bc[0]), _srgb_to_linear(bc[1]), _srgb_to_linear(bc[2])]


def _to_mtl_text(texture_filename=None, base_color=None):
    """MTL carrying the sculpt material colour; map_Kd only when a texture was written."""
    bc = _export_color(base_color)
    lines = [
        "# ComfyUI Sculpt Export",
        "newmtl sculpt_material",
        f"Kd {bc[0]:.4f} {bc[1]:.4f} {bc[2]:.4f}",
        "Ka 0.0000 0.0000 0.0000",
        "Ks 0.0000 0.0000 0.0000",
        "d 1.0",
        "illum 1",
    ]
    if texture_filename:
        lines.append(f"map_Kd {texture_filename}")
    return "\n".join(lines) + "\n"


def _to_stl_bytes(vertices, faces):
    """Binary STL: 80-byte header, triangle count, then normal + 3 vertices each."""
    v = np.asarray(vertices, dtype=np.float32).reshape(-1, 3)
    f = np.asarray(faces, dtype=np.int64).reshape(-1, 3)
    p0, p1, p2 = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    n = np.cross(p1 - p0, p2 - p0)
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    n = np.divide(n, ln, out=np.zeros_like(n), where=ln > 0).astype(np.float32)
    tri = np.zeros(len(f), dtype=[("n", "<f4", (3,)), ("v", "<f4", (3, 3)), ("attr", "<u2")])
    tri["n"] = n
    tri["v"][:, 0] = p0
    tri["v"][:, 1] = p1
    tri["v"][:, 2] = p2
    header = b"ComfyUI Sculpt Canvas binary STL".ljust(80, b"\0")
    return header + struct.pack("<I", len(f)) + tri.tobytes()


def _to_glb_bytes(vertices, faces, uvs=None, texture_png=None, base_color=None):
    """glTF 2.0 binary with one mesh. UVs are flipped to glTF's top-left origin."""
    v = np.asarray(vertices, dtype=np.float32).reshape(-1, 3)
    f = np.asarray(faces, dtype=np.uint32).reshape(-1, 3)
    n = _smooth_normals(v, f.astype(np.int64)).astype(np.float32)

    blobs, views = [], []
    offset = 0

    def add_view(raw, target=None):
        nonlocal offset
        pad = (-len(raw)) % 4
        blobs.append(raw + b"\0" * pad)
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(raw)}
        if target is not None:
            view["target"] = target
        views.append(view)
        offset += len(raw) + pad
        return len(views) - 1

    pos_view = add_view(v.tobytes(), 34962)
    nrm_view = add_view(n.tobytes(), 34962)
    uv_view = None
    if uvs is not None and len(uvs) == len(v) * 2:
        uv = np.asarray(uvs, dtype=np.float32).reshape(-1, 2)
        uv[:, 1] = 1.0 - uv[:, 1]
        uv_view = add_view(uv.tobytes(), 34962)
    idx_view = add_view(f.tobytes(), 34963)
    img_view = None
    if texture_png is not None and uv_view is not None:
        img_view = add_view(bytes(texture_png))

    accessors = [
        {"bufferView": pos_view, "componentType": 5126, "count": len(v), "type": "VEC3",
         "min": [float(x) for x in v.min(axis=0)], "max": [float(x) for x in v.max(axis=0)]},
        {"bufferView": nrm_view, "componentType": 5126, "count": len(n), "type": "VEC3"},
    ]
    attributes = {"POSITION": 0, "NORMAL": 1}
    if uv_view is not None:
        accessors.append({"bufferView": uv_view, "componentType": 5126, "count": len(v), "type": "VEC2"})
        attributes["TEXCOORD_0"] = len(accessors) - 1
    accessors.append({"bufferView": idx_view, "componentType": 5125, "count": int(f.size), "type": "SCALAR"})
    indices_accessor = len(accessors) - 1

    bc = _export_color(base_color)
    material = {
        "name": "sculpt_material",
        "pbrMetallicRoughness": {
            "baseColorFactor": [bc[0], bc[1], bc[2], 1.0],
            "metallicFactor": 0.0,
            "roughnessFactor": 0.8,
        },
    }
    gltf = {
        "asset": {"version": "2.0", "generator": "ComfyUI Sculpt Canvas"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "sculpt_mesh"}],
        "meshes": [{"name": "sculpt_mesh", "primitives": [
            {"attributes": attributes, "indices": indices_accessor, "material": 0}
        ]}],
        "materials": [material],
        "buffers": [{"byteLength": offset}],
        "bufferViews": views,
        "accessors": accessors,
    }
    if img_view is not None:
        material["pbrMetallicRoughness"]["baseColorFactor"] = [1.0, 1.0, 1.0, 1.0]
        material["pbrMetallicRoughness"]["baseColorTexture"] = {"index": 0}
        gltf["images"] = [{"bufferView": img_view, "mimeType": "image/png"}]
        gltf["samplers"] = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}]
        gltf["textures"] = [{"sampler": 0, "source": 0}]

    json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_bytes += b" " * ((-len(json_bytes)) % 4)
    bin_bytes = b"".join(blobs)
    total = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)
    return b"".join([
        struct.pack("<III", 0x46546C67, 2, total),
        struct.pack("<II", len(json_bytes), 0x4E4F534A), json_bytes,
        struct.pack("<II", len(bin_bytes), 0x004E4942), bin_bytes,
    ])


class SculptCanvas:
    """
    Interactive 3D sculpting in the node graph; exports OBJ and a preview image.

    Caching: ``IS_CHANGED`` fingerprints ``primitive``, ``subdivision``, and the
    full ``_sculpt_data`` string (SHA-256). Identical inputs reuse the cached
    execution; change the sculpt or primitive inputs to force a refresh.
    """

    RETURN_TYPES = ("STRING", "IMAGE", "STRING")
    RETURN_NAMES = ("mesh_obj", "preview_render", "mesh_path")
    OUTPUT_NODE = True
    FUNCTION = "export_mesh"
    CATEGORY = "Sculpt"
    DESCRIPTION = (
        "Sculpt a mesh in the embedded viewport; outputs OBJ text and a preview image. "
        "Preview background: viewport (gradient like the canvas) or transparent (alpha). "
        "mesh_obj is OBJ text (with UVs when the mesh has them). Set export_format "
        "to also write an OBJ, GLB, or STL file into the ComfyUI output folder; "
        "mesh_path returns its location. preview_size sets the preview resolution."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "primitive": (list(PRIMITIVE_TYPES), {"default": "sphere"}),
                "subdivision": ("INT", {"default": 4, "min": SUBDIVISION_MIN, "max": SUBDIVISION_MAX}),
                "preview_background": (
                    list(PREVIEW_BACKGROUNDS),
                    {"default": "viewport"},
                ),
            },
            "optional": {
                "_sculpt_data": ("STRING", {"default": "{}", "multiline": False}),
                # New inputs stay after _sculpt_data so workflows saved before
                # they existed still map widgets_values by position. The
                # frontend hides them and exposes panel controls instead.
                "preview_size": ("INT", {
                    "default": PREVIEW_SIZE_DEFAULT,
                    "min": PREVIEW_SIZE_MIN,
                    "max": PREVIEW_SIZE_MAX,
                    "step": 64,
                    "tooltip": "Preview image size in pixels (max edge for viewport capture).",
                }),
                "export_format": (list(EXPORT_FORMATS), {
                    "default": "none",
                    "tooltip": "Also write the mesh to the ComfyUI output folder.",
                }),
                "filename_prefix": ("STRING", {
                    "default": "sculpt",
                    "tooltip": "File name prefix for the exported mesh, like Save Image.",
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            }
        }

    @classmethod
    def IS_CHANGED(
        cls,
        primitive=None,
        subdivision=None,
        preview_background=None,
        _sculpt_data=None,
        preview_size=None,
        export_format=None,
        filename_prefix=None,
        **kwargs,
    ):
        prim = primitive if primitive is not None else "sphere"
        sub = subdivision if subdivision is not None else 4
        pbg = preview_background if preview_background is not None else "viewport"
        raw = _sculpt_data if _sculpt_data is not None else "{}"
        if not isinstance(raw, str):
            raw = "{}"
        psz = preview_size if preview_size is not None else PREVIEW_SIZE_DEFAULT
        fmt = export_format if export_format is not None else "none"
        pfx = filename_prefix if filename_prefix is not None else "sculpt"
        key = f"{prim}\0{sub}\0{pbg}\0{psz}\0{fmt}\0{pfx}\0{raw}"
        return hashlib.sha256(key.encode("utf-8", errors="replace")).hexdigest()

    @classmethod
    def VALIDATE_INPUTS(
        cls,
        primitive=None,
        subdivision=None,
        preview_background=None,
        _sculpt_data=None,
        preview_size=None,
        export_format=None,
        filename_prefix=None,
        **kwargs,
    ):
        # A custom validator suppresses ComfyUI's built-in combo/min/max checks
        # for every input it receives, so the widget inputs must be re-checked here.
        if primitive is not None and primitive not in PRIMITIVE_TYPES:
            return f"Invalid primitive '{primitive}' (expected one of: {', '.join(PRIMITIVE_TYPES)})"
        if subdivision is not None:
            if (
                isinstance(subdivision, bool)
                or not isinstance(subdivision, (int, float))
                or (isinstance(subdivision, float) and not subdivision.is_integer())
            ):
                return "subdivision must be an integer"
            if not (SUBDIVISION_MIN <= int(subdivision) <= SUBDIVISION_MAX):
                return f"subdivision must be between {SUBDIVISION_MIN} and {SUBDIVISION_MAX}"
        if preview_background is not None and preview_background not in PREVIEW_BACKGROUNDS:
            return (
                f"Invalid preview_background '{preview_background}' "
                f"(expected one of: {', '.join(PREVIEW_BACKGROUNDS)})"
            )
        if preview_size is not None:
            if (
                isinstance(preview_size, bool)
                or not isinstance(preview_size, (int, float))
                or (isinstance(preview_size, float) and not preview_size.is_integer())
            ):
                return "preview_size must be an integer"
            if not (PREVIEW_SIZE_MIN <= int(preview_size) <= PREVIEW_SIZE_MAX):
                return f"preview_size must be between {PREVIEW_SIZE_MIN} and {PREVIEW_SIZE_MAX}"
        if export_format is not None and export_format not in EXPORT_FORMATS:
            return f"Invalid export_format '{export_format}' (expected one of: {', '.join(EXPORT_FORMATS)})"
        if filename_prefix is not None:
            if not isinstance(filename_prefix, str) or not filename_prefix.strip():
                return "filename_prefix must be a non-empty string"
            if FILENAME_FORBIDDEN_RE.search(filename_prefix):
                return "filename_prefix must not contain < > : \" | ? * or control characters"

        raw = _sculpt_data if _sculpt_data is not None else "{}"
        if not isinstance(raw, str):
            return "Sculpt data must be a string"
        try:
            encoded = raw.encode("utf-8")
        except UnicodeEncodeError:
            return "Sculpt data is not valid UTF-8"
        if len(encoded) > MAX_SCULPT_DATA_BYTES:
            return (
                f"Sculpt data exceeds max size ({MAX_SCULPT_DATA_BYTES // (1024 * 1024)} MiB). "
                "Reduce mesh density or save mesh externally."
            )
        stripped = raw.strip()
        if not stripped:
            return True
        try:
            data = json.loads(raw)
        except (ValueError, RecursionError):
            return "Sculpt data is not valid JSON"
        if not isinstance(data, dict):
            return "Sculpt data JSON must be an object"
        ref = data.get("_meshRef")
        if ref is not None and (not isinstance(ref, str) or not MESH_REF_RE.fullmatch(ref)):
            return "Sculpt data '_meshRef' is not a valid mesh reference"
        tref = data.get("_textureRef")
        if tref is not None and (not isinstance(tref, str) or not MESH_REF_RE.fullmatch(tref)):
            return "Sculpt data '_textureRef' is not a valid texture reference"
        try:
            _extract_mesh_payload(data)
        except ValueError as e:
            return f"Invalid sculpt mesh data: {e}"
        return True

    def export_mesh(
        self,
        primitive,
        subdivision,
        preview_background="viewport",
        _sculpt_data="{}",
        preview_size=PREVIEW_SIZE_DEFAULT,
        export_format="none",
        filename_prefix="sculpt",
        unique_id=None,
    ):
        """
        Export the sculpted mesh as OBJ text, render a preview image, and
        optionally write an OBJ/GLB/STL file to the ComfyUI output folder.
        """
        data = {}
        if _sculpt_data and str(_sculpt_data).strip():
            try:
                data = json.loads(_sculpt_data)
            except (ValueError, RecursionError) as e:
                raise RuntimeError("Sculpt data is not valid JSON") from e

        try:
            mesh_data = _extract_mesh_payload(data)
        except ValueError as e:
            raise RuntimeError(f"Invalid sculpt mesh data: {e}") from e

        mesh_source = data if isinstance(data, dict) else {}
        if mesh_data is None and isinstance(data, dict):
            # Large meshes are persisted server-side; the workflow embeds only a
            # content-addressed reference. Resolve it before falling back.
            ref = data.get("_meshRef")
            if isinstance(ref, str) and MESH_REF_RE.fullmatch(ref):
                stored = _load_mesh_ref(ref)
                if stored is None:
                    raise RuntimeError(
                        "Sculpt mesh reference not found on this server. Open the "
                        "workflow in the browser so the mesh is re-uploaded, or "
                        "re-import the mesh into the Sculpt Canvas node."
                    )
                try:
                    mesh_data = _extract_mesh_payload(stored)
                except ValueError as e:
                    raise RuntimeError(f"Stored sculpt mesh is invalid: {e}") from e
                if mesh_data is None:
                    raise RuntimeError(
                        "Stored sculpt mesh contains no geometry. Re-open the "
                        "workflow in the browser so the mesh is re-uploaded, or "
                        "re-import the mesh into the Sculpt Canvas node."
                    )
                mesh_source = stored

        if mesh_data is not None:
            vertices, faces = mesh_data
            uvs = _extract_uvs(mesh_source, len(vertices) // 3)
        else:
            # `_meshOmittedFromWorkflow` means the frontend has a mesh that was
            # too large to embed. With no resolvable reference, persistence
            # never completed, and exporting the placeholder primitive would
            # hand back a different model than the one on screen.
            if isinstance(data, dict) and data.get("_meshOmittedFromWorkflow") is True:
                raise RuntimeError(
                    "Sculpt mesh was too large to embed in the workflow and no "
                    "server-side copy is referenced, so the sculpted geometry "
                    "cannot be recovered. Open the workflow in the browser and "
                    "wait for the mesh to finish saving (the node reports "
                    "persistence errors with a Retry action), then queue again."
                )
            vertices, faces = self._generate_primitive(primitive, subdivision)
            uvs = None

        preview_color = None
        if isinstance(data, dict):
            bc = data.get("baseColor")
            if isinstance(bc, list) and len(bc) >= 3:
                # Validation already guaranteed three finite numbers in [0, 1].
                preview_color = [float(bc[0]), float(bc[1]), float(bc[2])]

        transparent_bg = preview_background == "transparent"

        fmt = export_format if export_format in EXPORT_FORMATS else "none"
        texture_png = None
        tref = data.get("_textureRef") if isinstance(data, dict) else None
        if fmt in ("obj", "glb") and uvs is not None and isinstance(tref, str):
            texture_png = _load_texture_ref(tref)
            if texture_png is None:
                raise RuntimeError(
                    "Sculpt texture reference not found on this server. Re-import "
                    "the mesh with its image files in the Sculpt Canvas node and "
                    "queue again, or set export_format to stl for geometry only."
                )

        obj_string = self._to_obj(vertices, faces, uvs)

        mesh_path = ""
        if fmt != "none":
            mesh_path = self._write_export(
                fmt, filename_prefix, vertices, faces, uvs, texture_png, preview_color
            )

        try:
            size = int(preview_size)
        except (TypeError, ValueError):
            size = PREVIEW_SIZE_DEFAULT
        size = max(PREVIEW_SIZE_MIN, min(PREVIEW_SIZE_MAX, size))

        preview_cam = None
        if isinstance(data, dict):
            preview_cam = data.get("camera")

        preview = self._preview_from_viewport_capture(data)
        if preview is None:
            preview = self._render_preview(
                vertices,
                faces,
                width=size,
                height=size,
                base_color=preview_color,
                camera=preview_cam,
                transparent_bg=transparent_bg,
            )

        return (obj_string, preview, mesh_path)

    def _write_export(self, fmt, filename_prefix, vertices, faces, uvs, texture_png, base_color):
        """Write the mesh into the ComfyUI output folder and return its path."""
        try:
            return self._write_export_files(fmt, filename_prefix, vertices, faces, uvs, texture_png, base_color)
        except OSError as e:
            raise RuntimeError(f"Could not write the export file: {e}") from e

    def _write_export_files(self, fmt, filename_prefix, vertices, faces, uvs, texture_png, base_color):
        try:
            import folder_paths
        except ImportError as e:
            raise RuntimeError("Mesh export needs the ComfyUI runtime (folder_paths)") from e
        prefix = str(filename_prefix or "sculpt").strip() or "sculpt"
        output_dir = folder_paths.get_output_directory()
        try:
            full_folder, filename, counter, _subfolder, _prefix = folder_paths.get_save_image_path(
                prefix, output_dir
            )
        except Exception as e:
            raise RuntimeError(f"Invalid filename_prefix for export: {e}") from e
        os.makedirs(full_folder, exist_ok=True)
        stem = f"{filename}_{counter:05}_"

        if fmt == "obj":
            # Always write the material so the sculpt colour survives the trip;
            # the texture image only joins it when the mesh has one.
            mtl_name = stem + ".mtl"
            tex_name = None
            if uvs is not None and texture_png is not None:
                tex_name = stem + ".png"
                with open(os.path.join(full_folder, tex_name), "wb") as f:
                    f.write(texture_png)
            with open(os.path.join(full_folder, mtl_name), "w", encoding="utf-8") as f:
                f.write(_to_mtl_text(tex_name, base_color))
            path = os.path.join(full_folder, stem + ".obj")
            with open(path, "w", encoding="utf-8") as f:
                f.write(self._to_obj(vertices, faces, uvs, mtl_name))
            return path
        if fmt == "glb":
            path = os.path.join(full_folder, stem + ".glb")
            with open(path, "wb") as f:
                f.write(_to_glb_bytes(vertices, faces, uvs, texture_png, base_color))
            return path
        if fmt == "stl":
            path = os.path.join(full_folder, stem + ".stl")
            with open(path, "wb") as f:
                f.write(_to_stl_bytes(vertices, faces))
            return path
        raise RuntimeError(f"Unsupported export_format '{fmt}'")

    def _preview_from_viewport_capture(self, data):
        if not isinstance(data, dict):
            return None
        raw = data.get("viewportPngBase64")
        if not isinstance(raw, str) or not raw.strip():
            return None
        try:
            blob = base64.b64decode(raw.strip(), validate=False)
        except Exception:
            return None
        if len(blob) > PREVIEW_CAPTURE_MAX_BYTES:
            return None
        if blob[:8] != b"\x89PNG\r\n\x1a\n":
            return None
        try:
            from PIL import Image
        except ImportError:
            return None
        try:
            with Image.open(io.BytesIO(blob)) as source:
                width, height = source.size
                if width <= 0 or height <= 0 or width * height > PREVIEW_CAPTURE_MAX_PIXELS:
                    return None
                img = source.convert("RGBA")
        except Exception:
            return None
        arr = np.asarray(img, dtype=np.float32) / 255.0
        if arr.ndim != 3 or arr.shape[2] != 4:
            return None
        return torch.from_numpy(arr).unsqueeze(0)

    def _generate_primitive(self, primitive_type, subdivision):
        """Generate a primitive mesh."""
        if primitive_type == "sphere":
            return self._generate_sphere(1.0, subdivision)
        elif primitive_type == "cube":
            return self._generate_cube(1.0, subdivision)
        elif primitive_type == "cylinder":
            return self._generate_cylinder(0.5, 1.6, subdivision)
        elif primitive_type == "torus":
            return self._generate_torus(0.8, 0.3, subdivision)
        elif primitive_type == "plane":
            return self._generate_plane(2.0, subdivision + 1)
        return self._generate_sphere(1.0, subdivision)

    @staticmethod
    def _weld_primitive(vertices, faces):
        """Weld coincident built-in primitive seams without touching imports."""
        welded_vertices = []
        remap = [0] * (len(vertices) // 3)
        by_position = {}
        for index in range(len(vertices) // 3):
            base = index * 3
            xyz = vertices[base:base + 3]
            # Match JavaScript Math.round exactly (ties go toward +infinity)
            # so the backend fallback and viewport primitives stay identical.
            key = tuple(math.floor(value * 10_000_000 + 0.5) for value in xyz)
            welded_index = by_position.get(key)
            if welded_index is None:
                welded_index = len(welded_vertices) // 3
                by_position[key] = welded_index
                welded_vertices.extend(xyz)
            remap[index] = welded_index

        welded_faces = []
        for index in range(0, len(faces), 3):
            a, b, c = (remap[faces[index]], remap[faces[index + 1]], remap[faces[index + 2]])
            if a != b and b != c and c != a:
                welded_faces.extend([a, b, c])
        return welded_vertices, welded_faces

    def _generate_cylinder(self, radius, height, subdivision):
        segments = 2 ** (subdivision + 1)
        h_segments = 2 ** subdivision
        vertices, faces = [], []
        for y in range(h_segments + 1):
            py = (y / h_segments - 0.5) * height
            for x in range(segments + 1):
                theta = x * 2 * math.pi / segments
                vertices.extend([radius * math.cos(theta), py, radius * math.sin(theta)])
        cols = segments + 1
        for y in range(h_segments):
            for x in range(segments):
                v0, v1, v2, v3 = y * cols + x, y * cols + x + 1, (y + 1) * cols + x, (y + 1) * cols + x + 1
                faces.extend([v0, v1, v2])
                faces.extend([v1, v3, v2])

        bottom_center = len(vertices) // 3
        vertices.extend([0.0, -height * 0.5, 0.0])
        top_center = len(vertices) // 3
        vertices.extend([0.0, height * 0.5, 0.0])
        top_ring_start = h_segments * cols
        for i in range(segments):
            faces.extend([bottom_center, i + 1, i])
            faces.extend([top_center, top_ring_start + i, top_ring_start + i + 1])
        return self._weld_primitive(vertices, faces)

    def _generate_torus(self, radius, tube, subdivision):
        r_segs = 2 ** (subdivision + 1)
        t_segs = 2 ** (subdivision + 1)
        vertices, faces = [], []
        for j in range(r_segs + 1):
            for i in range(t_segs + 1):
                u, v = i / t_segs * 2 * math.pi, j / r_segs * 2 * math.pi
                x = (radius + tube * math.cos(v)) * math.cos(u)
                y = (radius + tube * math.cos(v)) * math.sin(u)
                z = tube * math.sin(v)
                vertices.extend([x, y, z])
        cols = t_segs + 1
        for j in range(r_segs):
            for i in range(t_segs):
                v0, v1, v2, v3 = j * cols + i, j * cols + i + 1, (j + 1) * cols + i, (j + 1) * cols + i + 1
                faces.extend([v0, v1, v2])
                faces.extend([v1, v3, v2])
        return self._weld_primitive(vertices, faces)

    def _generate_plane(self, size, subdivision):
        segs = 2 ** subdivision
        vertices, faces = [], []
        for y in range(segs + 1):
            for x in range(segs + 1):
                vertices.extend([(x / segs - 0.5) * size, 0, (y / segs - 0.5) * size])
        cols = segs + 1
        for y in range(segs):
            for x in range(segs):
                v0, v1, v2, v3 = y * cols + x, y * cols + x + 1, (y + 1) * cols + x, (y + 1) * cols + x + 1
                faces.extend([v0, v2, v1])
                faces.extend([v1, v2, v3])
        return self._weld_primitive(vertices, faces)

    def _generate_sphere(self, radius, subdivision):
        """Generate a UV sphere."""
        lat_segments = 2 ** (subdivision + 2)
        lon_segments = lat_segments * 2

        vertices = []
        faces = []

        # Top pole
        vertices.extend([0.0, radius, 0.0])

        # Body rings (exclude poles)
        for lat in range(1, lat_segments):
            theta = lat * math.pi / lat_segments
            sin_theta = math.sin(theta)
            cos_theta = math.cos(theta)

            for lon in range(lon_segments):
                phi = lon * 2 * math.pi / lon_segments
                x = radius * sin_theta * math.cos(phi)
                y = radius * cos_theta
                z = radius * sin_theta * math.sin(phi)
                vertices.extend([x, y, z])

        # Bottom pole
        bottom_index = len(vertices) // 3
        vertices.extend([0.0, -radius, 0.0])

        # Top cap
        for lon in range(lon_segments):
            curr = 1 + lon
            nxt = 1 + ((lon + 1) % lon_segments)
            faces.extend([0, curr, nxt])

        # Middle bands
        for lat in range(lat_segments - 2):
            row_start = 1 + lat * lon_segments
            next_row_start = row_start + lon_segments

            for lon in range(lon_segments):
                curr = row_start + lon
                nxt = row_start + ((lon + 1) % lon_segments)
                down = next_row_start + lon
                down_next = next_row_start + ((lon + 1) % lon_segments)

                faces.extend([curr, down, nxt])
                faces.extend([nxt, down, down_next])

        # Bottom cap
        last_ring_start = 1 + (lat_segments - 2) * lon_segments
        for lon in range(lon_segments):
            curr = last_ring_start + lon
            nxt = last_ring_start + ((lon + 1) % lon_segments)
            faces.extend([curr, bottom_index, nxt])

        return self._weld_primitive(vertices, faces)

    def _generate_cube(self, size, subdivision):
        """Generate a subdivided cube."""
        half = size / 2
        segments = 2 ** subdivision

        vertices = []
        faces = []
        vertex_index = 0

        cube_faces = [
            ([-half, -half, half], [1, 0, 0], [0, 1, 0]),    # Front
            ([half, -half, -half], [-1, 0, 0], [0, 1, 0]),   # Back
            ([-half, half, -half], [1, 0, 0], [0, 0, 1]),    # Top
            ([-half, -half, half], [1, 0, 0], [0, 0, -1]),   # Bottom
            ([half, -half, -half], [0, 0, 1], [0, 1, 0]),    # Right
            ([-half, -half, half], [0, 0, -1], [0, 1, 0]),   # Left
        ]

        for origin, u_axis, v_axis in cube_faces:
            start_index = vertex_index
            for i in range(segments + 1):
                for j in range(segments + 1):
                    u = i / segments
                    v = j / segments
                    x = origin[0] + u * size * u_axis[0] + v * size * v_axis[0]
                    y = origin[1] + u * size * u_axis[1] + v * size * v_axis[1]
                    z = origin[2] + u * size * u_axis[2] + v * size * v_axis[2]
                    vertices.extend([x, y, z])
                    vertex_index += 1

            cols = segments + 1
            for i in range(segments):
                for j in range(segments):
                    v0 = start_index + i * cols + j
                    v1 = v0 + 1
                    v2 = v0 + cols
                    v3 = v2 + 1
                    faces.extend([v0, v2, v1])
                    faces.extend([v1, v2, v3])

        return self._weld_primitive(vertices, faces)

    def _to_obj(self, vertices, faces, uvs=None, mtl_name=None):
        """OBJ text with smooth normals; adds vt lines and a material when available."""
        v = np.array(vertices, dtype=np.float32).reshape(-1, 3)
        f = np.array(faces, dtype=np.int32).reshape(-1, 3)
        normals = _smooth_normals(v, f)
        has_uv = uvs is not None and len(uvs) == len(v) * 2

        lines = ["# ComfyUI Sculpt Export", "# Generated with Sculpt Canvas node"]
        if mtl_name:
            lines.append(f"mtllib {mtl_name}")
        lines.append("g sculpt_mesh")
        if mtl_name:
            lines.append("usemtl sculpt_material")
        for i in range(len(v)):
            lines.append(f"v {v[i, 0]:.6f} {v[i, 1]:.6f} {v[i, 2]:.6f}")
        if has_uv:
            for i in range(len(v)):
                lines.append(f"vt {uvs[2 * i]:.6f} {uvs[2 * i + 1]:.6f}")
        for i in range(len(normals)):
            lines.append(f"vn {normals[i, 0]:.4f} {normals[i, 1]:.4f} {normals[i, 2]:.4f}")

        if has_uv:
            for i in range(len(f)):
                a, b, c = (int(x) + 1 for x in f[i])
                lines.append(f"f {a}/{a}/{a} {b}/{b}/{b} {c}/{c}/{c}")
        else:
            for i in range(len(f)):
                a, b, c = (int(x) + 1 for x in f[i])
                lines.append(f"f {a}//{a} {b}//{b} {c}//{c}")
        return "\n".join(lines)

    def _prepare_preview_mesh(self, verts, face_indices):
        """
        Cap vertex/triangle counts for CPU rasterization.

        The subset is drawn uniformly at random rather than strided, so coverage
        stays even across the surface instead of leaving holes in the preview.
        """
        verts = np.asarray(verts, dtype=np.float32).reshape(-1, 3)
        face_indices = np.asarray(face_indices, dtype=np.int32).reshape(-1, 3)
        n_tri = int(face_indices.shape[0])
        n_v = int(verts.shape[0])
        if n_tri == 0:
            return verts, face_indices
        if n_tri <= PREVIEW_MAX_CPU_TRIANGLES and n_v <= PREVIEW_MAX_VERTICES:
            return verts, face_indices

        rng = np.random.default_rng(137)
        target_tri = min(PREVIEW_MAX_CPU_TRIANGLES, n_tri)
        new_verts = verts
        inv = face_indices
        for _ in range(12):
            tt = min(target_tri, n_tri)
            pick = rng.choice(n_tri, size=tt, replace=False)
            face_sub = face_indices[pick]
            used, inv_flat = np.unique(face_sub.ravel(), return_inverse=True)
            inv = inv_flat.reshape(face_sub.shape).astype(np.int32)
            new_verts = verts[used]
            if new_verts.shape[0] <= PREVIEW_MAX_VERTICES:
                return new_verts, inv
            target_tri = max(1, (target_tri * 2) // 3)
        return new_verts, inv

    @staticmethod
    def _vertex_normals(verts, face_indices):
        v = verts
        f = face_indices
        e1 = v[f[:, 1]] - v[f[:, 0]]
        e2 = v[f[:, 2]] - v[f[:, 0]]
        fn = np.cross(e1, e2)
        acc = np.zeros_like(v)
        for i in range(3):
            np.add.at(acc, f[:, i], fn)
        norm = np.linalg.norm(acc, axis=1, keepdims=True)
        return np.divide(acc, norm, out=np.zeros_like(acc), where=norm > 1e-20)

    @staticmethod
    def _look_at_4x4(eye, target, up):
        eye = np.asarray(eye, dtype=np.float64).reshape(3)
        target = np.asarray(target, dtype=np.float64).reshape(3)
        up = np.asarray(up, dtype=np.float64).reshape(3)
        z_axis = eye - target
        ln = np.linalg.norm(z_axis)
        if ln < 1e-12:
            z_axis = np.array([0.0, 0.0, 1.0], dtype=np.float64)
        else:
            z_axis /= ln
        x_axis = np.cross(up, z_axis)
        ln = np.linalg.norm(x_axis)
        if ln < 1e-12:
            x_axis = np.array([1.0, 0.0, 0.0], dtype=np.float64)
        else:
            x_axis /= ln
        y_axis = np.cross(z_axis, x_axis)
        # Column-vector convention: the renderer computes v @ [x y z 1]^T, so the
        # basis axes are rows and the translation lives in the last column.
        return np.array(
            [
                [x_axis[0], x_axis[1], x_axis[2], -np.dot(x_axis, eye)],
                [y_axis[0], y_axis[1], y_axis[2], -np.dot(y_axis, eye)],
                [z_axis[0], z_axis[1], z_axis[2], -np.dot(z_axis, eye)],
                [0.0, 0.0, 0.0, 1.0],
            ],
            dtype=np.float64,
        )

    @staticmethod
    def _perspective_4x4(fov_y_deg, aspect, near, far):
        f = 1.0 / math.tan(math.radians(fov_y_deg) * 0.5)
        nf = 1.0 / (near - far)
        return np.array(
            [
                [f / aspect, 0.0, 0.0, 0.0],
                [0.0, f, 0.0, 0.0],
                [0.0, 0.0, (far + near) * nf, 2.0 * far * near * nf],
                [0.0, 0.0, -1.0, 0.0],
            ],
            dtype=np.float64,
        )

    def _camera_pv(self, camera, width, height):
        aspect = float(width) / max(float(height), 1.0)
        dist = 3.0
        theta = math.pi / 4.0
        phi = math.pi / 6.0
        target = np.array([0.0, 0.0, 0.0], dtype=np.float64)
        fov = 45.0
        near = 0.1
        far = 100.0
        if isinstance(camera, dict):
            dist = float(camera.get("distance", dist))
            theta = float(camera.get("theta", theta))
            phi = float(camera.get("phi", phi))
            t = camera.get("target")
            if isinstance(t, list) and len(t) >= 3:
                target = np.array(
                    [float(t[0]), float(t[1]), float(t[2])], dtype=np.float64
                )
            fov = float(camera.get("fov", fov))
            near = float(camera.get("near", near))
            far = float(camera.get("far", far))
        x = dist * math.sin(theta) * math.cos(phi)
        y = dist * math.sin(phi)
        z = dist * math.cos(theta) * math.cos(phi)
        eye = np.array(
            [x + target[0], y + target[1], z + target[2]], dtype=np.float64
        )
        up = np.array([0.0, 1.0, 0.0], dtype=np.float64)
        v = self._look_at_4x4(eye, target, up)
        p = self._perspective_4x4(fov, aspect, near, far)
        return p, v

    def _render_preview(
        self,
        vertices,
        faces,
        width=512,
        height=512,
        base_color=None,
        camera=None,
        transparent_bg=False,
    ):
        """CPU preview: same camera + perspective as SculptEngine (matches viewport framing)."""
        # Keep one stable IMAGE channel contract across capture and fallback.
        image = np.zeros((height, width, 4), dtype=np.float32)
        if not transparent_bg:
            image[:, :, :3] = 0.15
            image[:, :, 3] = 1.0

        if not vertices or not faces:
            return torch.from_numpy(image).unsqueeze(0)

        verts = np.array(vertices, dtype=np.float64).reshape(-1, 3)
        face_indices = np.array(faces, dtype=np.int32).reshape(-1, 3)
        verts, face_indices = self._prepare_preview_mesh(verts, face_indices)

        p, v = self._camera_pv(camera, width, height)
        r = v[:3, :3]
        pos_h = np.hstack([verts, np.ones((verts.shape[0], 1))])
        view_h = (v @ pos_h.T).astype(np.float64)
        clip_h = (p @ view_h).astype(np.float64)
        w = clip_h[3]
        w_safe = np.where(np.abs(w) > 1e-10, w, np.sign(w) * 1e-10 + 1e-10)
        ndc = clip_h[:3] / w_safe
        ndc_x = ndc[0]
        ndc_y = ndc[1]
        ndc_z = ndc[2]
        px = (ndc_x * 0.5 + 0.5) * width
        py = (1.0 - (ndc_y * 0.5 + 0.5)) * height
        v_proj = np.stack([px, py], axis=1)

        vn = self._vertex_normals(verts.astype(np.float32), face_indices).astype(np.float64)
        n_view = (r @ vn.T).T
        nn = np.linalg.norm(n_view, axis=1, keepdims=True)
        n_view = np.divide(n_view, nn, out=np.zeros_like(n_view), where=nn > 1e-20)

        l_w = np.array([0.5, 0.7, 0.5], dtype=np.float64)
        l_w /= max(np.linalg.norm(l_w), 1e-9)
        l_v = (r @ l_w.reshape(3, 1)).reshape(3)
        ln = np.linalg.norm(l_v)
        if ln > 1e-9:
            l_v /= ln
        bright_v = np.maximum(
            0.12, np.sum(n_view * l_v, axis=1) * 0.62 + 0.38
        )
        if base_color is not None and len(base_color) >= 3:
            bc = np.array(
                [float(base_color[0]), float(base_color[1]), float(base_color[2])],
                dtype=np.float64,
            )
        else:
            bc = np.array([0.7, 0.65, 0.6], dtype=np.float64)
        bc = np.clip(bc, 0.0, 1.0)
        rgb_v = bc[None, :] * bright_v[:, None]

        zbuf = np.full((height, width), np.inf, dtype=np.float64)
        tri_z = ndc_z[face_indices]
        fi = face_indices
        raster_pixels_left = PREVIEW_MAX_RASTER_PIXELS
        for i in range(fi.shape[0]):
            idx = fi[i]
            if np.any(w[idx] <= 1e-8):
                continue
            pts = v_proj[idx]
            c0 = rgb_v[idx[0]]
            c1 = rgb_v[idx[1]]
            c2 = rgb_v[idx[2]]
            used = self._fill_triangle_zbuffer(
                image,
                zbuf,
                pts,
                tri_z[i],
                c0,
                c1,
                c2,
                pixel_budget=raster_pixels_left,
            )
            if used is None:
                break
            raster_pixels_left -= used

        return torch.from_numpy(image).unsqueeze(0)

    def _fill_triangle_zbuffer(
        self, image, zbuf, pts, ztri, color0, color1, color2, pixel_budget=None
    ):
        """Barycentric rasterization; interpolates vertex RGB (Gouraud)."""
        h, w = image.shape[:2]
        ax, ay = float(pts[0, 0]), float(pts[0, 1])
        bx, by = float(pts[1, 0]), float(pts[1, 1])
        cx, cy = float(pts[2, 0]), float(pts[2, 1])
        z0, z1, z2 = float(ztri[0]), float(ztri[1]), float(ztri[2])
        c0 = np.asarray(color0, dtype=np.float64)
        c1 = np.asarray(color1, dtype=np.float64)
        c2 = np.asarray(color2, dtype=np.float64)

        v1x, v1y = bx - ax, by - ay
        v2x, v2y = cx - ax, cy - ay
        det = v1x * v2y - v1y * v2x
        if abs(det) < 1e-14:
            return 0
        inv_det = 1.0 / det

        xmin = int(max(0, np.floor(min(ax, bx, cx))))
        xmax = int(min(w - 1, np.ceil(max(ax, bx, cx))))
        ymin = int(max(0, np.floor(min(ay, by, cy))))
        ymax = int(min(h - 1, np.ceil(max(ay, by, cy))))
        if xmin > xmax or ymin > ymax:
            return 0

        bbox_pixels = (xmax - xmin + 1) * (ymax - ymin + 1)
        if pixel_budget is not None and bbox_pixels > pixel_budget:
            return None

        # Vectorized over the pixel rectangle to keep the triangle budget
        # affordable in worst-case previews.
        xs = np.arange(xmin, xmax + 1, dtype=np.float64)[None, :]
        ys = np.arange(ymin, ymax + 1, dtype=np.float64)[:, None]
        vpx = xs - ax
        vpy = ys - ay
        beta = (vpx * v2y - vpy * v2x) * inv_det
        gamma = (v1x * vpy - v1y * vpx) * inv_det
        alpha = 1.0 - beta - gamma
        inside = (alpha >= -1e-6) & (beta >= -1e-6) & (gamma >= -1e-6)
        if not np.any(inside):
            return bbox_pixels
        z = alpha * z0 + beta * z1 + gamma * z2
        zregion = zbuf[ymin : ymax + 1, xmin : xmax + 1]
        visible = inside & (z < zregion)
        if not np.any(visible):
            return bbox_pixels
        zregion[visible] = z[visible]
        color = np.clip(
            alpha[..., None] * c0 + beta[..., None] * c1 + gamma[..., None] * c2,
            0.0,
            1.0,
        )
        region = image[ymin : ymax + 1, xmin : xmax + 1]
        region[..., :3][visible] = color[visible]
        region[..., 3][visible] = 1.0
        return bbox_pixels
