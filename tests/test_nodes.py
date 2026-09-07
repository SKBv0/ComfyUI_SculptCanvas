import base64
import hashlib
import io
import importlib.util
import json
import os
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
NODES_MODULE_NAME = "comfyui_sculpt_nodes_under_test"
nodes_mod = sys.modules.get(NODES_MODULE_NAME)
if nodes_mod is None:
    spec = importlib.util.spec_from_file_location(
        NODES_MODULE_NAME, os.path.join(ROOT, "nodes.py")
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load local Sculpt nodes.py")
    nodes_mod = importlib.util.module_from_spec(spec)
    sys.modules[NODES_MODULE_NAME] = nodes_mod
    spec.loader.exec_module(nodes_mod)


class TestSculptCanvasValidateInputs(unittest.TestCase):
    def test_empty_data_ok(self):
        self.assertIs(
            nodes_mod.SculptCanvas.VALIDATE_INPUTS(_sculpt_data="{}"), True
        )

    def test_invalid_json(self):
        err = nodes_mod.SculptCanvas.VALIDATE_INPUTS(_sculpt_data="{not json")
        self.assertIsInstance(err, str)
        self.assertIn("JSON", err)

    def test_vertices_not_list(self):
        err = nodes_mod.SculptCanvas.VALIDATE_INPUTS(_sculpt_data='{"vertices": 1}')
        self.assertIsInstance(err, str)

    def test_vertex_count_limit(self):
        old = nodes_mod.MAX_MESH_VERTICES
        nodes_mod.MAX_MESH_VERTICES = 2
        try:
            payload = {"vertices": [0.0] * 9, "faces": [0, 1, 2]}
            err = nodes_mod.SculptCanvas.VALIDATE_INPUTS(
                _sculpt_data=json.dumps(payload)
            )
            self.assertIsInstance(err, str)
            self.assertIn("vertex", err.lower())
        finally:
            nodes_mod.MAX_MESH_VERTICES = old

    def test_face_index_limit(self):
        old = nodes_mod.MAX_MESH_FACE_INDICES
        nodes_mod.MAX_MESH_FACE_INDICES = 3
        try:
            verts = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
            payload = {"vertices": verts, "faces": [0, 1, 2, 0, 1, 2]}
            err = nodes_mod.SculptCanvas.VALIDATE_INPUTS(
                _sculpt_data=json.dumps(payload)
            )
            self.assertIsInstance(err, str)
            self.assertIn("face", err.lower())
        finally:
            nodes_mod.MAX_MESH_FACE_INDICES = old

    def test_payload_byte_limit(self):
        old = nodes_mod.MAX_SCULPT_DATA_BYTES
        nodes_mod.MAX_SCULPT_DATA_BYTES = 16
        try:
            raw = "y" * 20
            err = nodes_mod.SculptCanvas.VALIDATE_INPUTS(_sculpt_data=raw)
            self.assertIsInstance(err, str)
            self.assertIn("size", err.lower())
        finally:
            nodes_mod.MAX_SCULPT_DATA_BYTES = old

    def test_vertex_mask_length_mismatch(self):
        payload = {
            "vertices": [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            "faces": [0, 1, 2],
            "vertexMask": [0.0, 1.0],
        }
        err = nodes_mod.SculptCanvas.VALIDATE_INPUTS(_sculpt_data=json.dumps(payload))
        self.assertIsInstance(err, str)
        self.assertIn("vertexMask", err)

    def test_vertex_mask_not_list(self):
        payload = {
            "vertices": [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            "faces": [0, 1, 2],
            "vertexMask": "bad",
        }
        err = nodes_mod.SculptCanvas.VALIDATE_INPUTS(_sculpt_data=json.dumps(payload))
        self.assertIsInstance(err, str)

    def test_vertex_mask_ok_when_matching(self):
        payload = {
            "vertices": [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            "faces": [0, 1, 2],
            "vertexMask": [0.0, 0.5, 1.0],
        }
        self.assertIs(
            nodes_mod.SculptCanvas.VALIDATE_INPUTS(_sculpt_data=json.dumps(payload)),
            True,
        )

    def test_vertex_mask_rejects_nonfinite_and_out_of_range_values(self):
        base = {
            "vertices": [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            "faces": [0, 1, 2],
        }
        for mask in ([0.0, float("nan"), 1.0], [0.0, 1.1, 1.0]):
            err = nodes_mod.SculptCanvas.VALIDATE_INPUTS(
                _sculpt_data=json.dumps({**base, "vertexMask": mask})
            )
            self.assertIsInstance(err, str)
            self.assertIn("vertexMask", err)

    def test_uvs_reject_wrong_length_and_nonfinite_values(self):
        base = {
            "vertices": [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            "faces": [0, 1, 2],
        }
        for uvs in ([0.0, 0.0], [0.0, 0.0, 1.0, 0.0, float("nan"), 1.0]):
            err = nodes_mod.SculptCanvas.VALIDATE_INPUTS(
                _sculpt_data=json.dumps({**base, "uvs": uvs})
            )
            self.assertIsInstance(err, str)
            self.assertIn("uvs", err)

    def test_vertex_owners_reject_invalid_values(self):
        base = {
            "vertices": [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            "faces": [0, 1, 2],
        }
        for owners in ([0, 0], [0, -1, 0], [0, True, 0], [0, 1.5, 0]):
            with self.subTest(owners=owners):
                err = nodes_mod.SculptCanvas.VALIDATE_INPUTS(
                    _sculpt_data=json.dumps({**base, "vertexOwners": owners})
                )
                self.assertIsInstance(err, str)
                self.assertIn("vertexOwners", err)

    def test_rejects_nonfinite_color_and_invalid_camera_projection(self):
        base = {
            "vertices": [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            "faces": [0, 1, 2],
        }
        cases = (
            {"baseColor": [float("nan"), 0.2, 0.3]},
            {"camera": {"fov": 0}},
            {"camera": {"distance": float("inf")}},
            {"camera": {"distance": 1e300}},
            {"camera": {"target": [1e300, 0.0, 0.0]}},
            {"camera": {"near": 1.0, "far": 0.5}},
            {"camera": {"near": 9e299, "far": 1e300}},
        )
        for extra in cases:
            err = nodes_mod.SculptCanvas.VALIDATE_INPUTS(
                _sculpt_data=json.dumps({**base, **extra})
            )
            self.assertIsInstance(err, str)


class TestWidgetInputValidation(unittest.TestCase):
    """Custom validators disable ComfyUI's built-in combo/min/max checks, so
    VALIDATE_INPUTS must reject invalid widget values itself."""

    def test_invalid_primitive_rejected(self):
        err = nodes_mod.SculptCanvas.VALIDATE_INPUTS(primitive="not-a-primitive")
        self.assertIsInstance(err, str)
        self.assertIn("primitive", err)

    def test_subdivision_out_of_range_rejected(self):
        err = nodes_mod.SculptCanvas.VALIDATE_INPUTS(subdivision=1000000)
        self.assertIsInstance(err, str)
        self.assertIn("subdivision", err)

    def test_subdivision_non_integer_rejected(self):
        err = nodes_mod.SculptCanvas.VALIDATE_INPUTS(subdivision=2.5)
        self.assertIsInstance(err, str)

    def test_invalid_preview_background_rejected(self):
        err = nodes_mod.SculptCanvas.VALIDATE_INPUTS(
            preview_background="not-a-background"
        )
        self.assertIsInstance(err, str)
        self.assertIn("preview_background", err)

    def test_valid_widget_values_pass(self):
        self.assertIs(
            nodes_mod.SculptCanvas.VALIDATE_INPUTS(
                primitive="torus",
                subdivision=3,
                preview_background="transparent",
                _sculpt_data="{}",
            ),
            True,
        )

    def test_malformed_face_arity_rejected(self):
        payload = {
            "vertices": [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            "faces": [0, 1, 2, 0],
        }
        err = nodes_mod.SculptCanvas.VALIDATE_INPUTS(_sculpt_data=json.dumps(payload))
        self.assertIsInstance(err, str)

    def test_invalid_mesh_ref_rejected(self):
        payload = {"_meshOmittedFromWorkflow": True, "_meshRef": "../evil"}
        err = nodes_mod.SculptCanvas.VALIDATE_INPUTS(_sculpt_data=json.dumps(payload))
        self.assertIsInstance(err, str)
        self.assertIn("_meshRef", err)

    def test_valid_mesh_ref_stub_passes(self):
        payload = {"_meshOmittedFromWorkflow": True, "_meshRef": "a" * 64}
        self.assertIs(
            nodes_mod.SculptCanvas.VALIDATE_INPUTS(_sculpt_data=json.dumps(payload)),
            True,
        )


class TestExtractMeshPayload(unittest.TestCase):
    def test_valid_triangle(self):
        data = {
            "vertices": [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            "faces": [0, 1, 2],
        }
        out = nodes_mod._extract_mesh_payload(data)
        self.assertIsNotNone(out)
        v, f = out
        self.assertEqual(len(v), 9)
        self.assertEqual(len(f), 3)

    def test_absent_mesh_returns_none(self):
        self.assertIsNone(nodes_mod._extract_mesh_payload({}))
        self.assertIsNone(nodes_mod._extract_mesh_payload(None))
        self.assertIsNone(
            nodes_mod._extract_mesh_payload({"_meshOmittedFromWorkflow": True})
        )

    def test_bad_face_index_raises(self):
        data = {
            "vertices": [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            "faces": [0, 1, 99],
        }
        with self.assertRaises(ValueError):
            nodes_mod._extract_mesh_payload(data)

    def test_non_finite_vertex_raises(self):
        data = {
            "vertices": [0.0, 0.0, float("inf"), 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            "faces": [0, 1, 2],
        }
        with self.assertRaises(ValueError):
            nodes_mod._extract_mesh_payload(data)

    def test_extreme_finite_vertices_are_rejected_before_float32_overflow(self):
        data = {
            "vertices": [1e300, 0, 0, 0, 1e300, 0, 0, 0, 1e300],
            "faces": [0, 1, 2],
        }
        with self.assertRaisesRegex(ValueError, "within"):
            nodes_mod._extract_mesh_payload(data)

    def test_missing_faces_raises(self):
        data = {"vertices": [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]}
        with self.assertRaises(ValueError):
            nodes_mod._extract_mesh_payload(data)


class TestMeshRefStore(unittest.TestCase):
    def test_load_mesh_ref_roundtrip_and_traversal_guard(self):
        import tempfile
        import types

        with tempfile.TemporaryDirectory() as td:
            fake = types.ModuleType("folder_paths")
            fake.get_user_directory = lambda: td
            sys.modules["folder_paths"] = fake
            try:
                base = nodes_mod._mesh_store_dir(create=True)
                self.assertTrue(os.path.isdir(base))
                payload = {
                    "vertices": [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
                    "faces": [0, 1, 2],
                }
                raw = json.dumps(payload).encode("utf-8")
                ref = hashlib.sha256(raw).hexdigest()
                path = os.path.join(base, f"{ref}.json")
                with open(path, "wb") as f:
                    f.write(raw)
                data = nodes_mod._load_mesh_ref(ref)
                self.assertIsInstance(data, dict)
                self.assertEqual(len(data["faces"]), 3)
                with open(path, "ab") as f:
                    f.write(b" ")
                self.assertIsNone(nodes_mod._load_mesh_ref(ref))
                self.assertIsNone(nodes_mod._load_mesh_ref("../evil"))
                self.assertIsNone(nodes_mod._load_mesh_ref("ZZ" * 32))
                self.assertIsNone(nodes_mod._load_mesh_ref("f" * 64))
            finally:
                del sys.modules["folder_paths"]

    def test_truncated_legacy_ref_is_still_content_verified(self):
        """A short ref is a truncated digest, not a licence to skip the check."""
        import tempfile
        import types

        with tempfile.TemporaryDirectory() as td:
            fake = types.ModuleType("folder_paths")
            fake.get_user_directory = lambda: td
            sys.modules["folder_paths"] = fake
            try:
                base = nodes_mod._mesh_store_dir(create=True)
                payload = {
                    "vertices": [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
                    "faces": [0, 1, 2],
                }
                raw = json.dumps(payload).encode("utf-8")
                short_ref = hashlib.sha256(raw).hexdigest()[:16]
                path = os.path.join(base, f"{short_ref}.json")
                with open(path, "wb") as f:
                    f.write(raw)

                self.assertIsInstance(nodes_mod._load_mesh_ref(short_ref), dict)

                # Same short name, contents swapped: must now be rejected.
                with open(path, "wb") as f:
                    f.write(json.dumps({"vertices": [9.0] * 9,
                                        "faces": [0, 1, 2]}).encode("utf-8"))
                self.assertIsNone(nodes_mod._load_mesh_ref(short_ref))
            finally:
                del sys.modules["folder_paths"]


class TestCameraMatrix(unittest.TestCase):
    def test_default_camera_maps_target_to_view_depth(self):
        import numpy as np

        node = nodes_mod.SculptCanvas()
        _, v = node._camera_pv(None, 512, 512)
        origin = np.array([0.0, 0.0, 0.0, 1.0])
        view = v @ origin
        self.assertAlmostEqual(view[0], 0.0, places=9)
        self.assertAlmostEqual(view[1], 0.0, places=9)
        self.assertAlmostEqual(view[2], -3.0, places=9)
        self.assertAlmostEqual(view[3], 1.0, places=9)


class TestPreviewContract(unittest.TestCase):
    def test_cpu_preview_is_always_rgba(self):
        node = nodes_mod.SculptCanvas()
        viewport = node._render_preview([], [], width=4, height=3, transparent_bg=False)
        transparent = node._render_preview([], [], width=4, height=3, transparent_bg=True)
        self.assertEqual(tuple(viewport.shape), (1, 3, 4, 4))
        self.assertEqual(tuple(transparent.shape), (1, 3, 4, 4))
        self.assertTrue((viewport[..., 3] == 1).all().item())
        self.assertTrue((transparent[..., 3] == 0).all().item())

    def test_vectorized_triangle_rasterizer_writes_visible_rgba(self):
        import numpy as np

        node = nodes_mod.SculptCanvas()
        image = np.zeros((8, 8, 4), dtype=np.float32)
        zbuf = np.full((8, 8), np.inf, dtype=np.float64)
        points = np.array([[1.0, 1.0], [6.0, 1.0], [1.0, 6.0]])
        node._fill_triangle_zbuffer(
            image,
            zbuf,
            points,
            np.array([0.2, 0.2, 0.2]),
            np.array([1.0, 0.0, 0.0]),
            np.array([0.0, 1.0, 0.0]),
            np.array([0.0, 0.0, 1.0]),
        )
        self.assertGreater(int(np.count_nonzero(image[..., 3])), 0)

    def test_triangle_rasterizer_refuses_work_over_remaining_pixel_budget(self):
        import numpy as np

        node = nodes_mod.SculptCanvas()
        image = np.zeros((8, 8, 4), dtype=np.float32)
        zbuf = np.full((8, 8), np.inf, dtype=np.float64)
        result = node._fill_triangle_zbuffer(
            image,
            zbuf,
            np.array([[0.0, 0.0], [7.0, 0.0], [0.0, 7.0]]),
            np.array([0.2, 0.2, 0.2]),
            np.array([1.0, 0.0, 0.0]),
            np.array([0.0, 1.0, 0.0]),
            np.array([0.0, 0.0, 1.0]),
            pixel_budget=63,
        )
        self.assertIsNone(result)
        self.assertEqual(int(np.count_nonzero(image)), 0)

    def test_viewport_capture_pixel_budget(self):
        from PIL import Image

        out = io.BytesIO()
        Image.new("RGBA", (3, 2), (1, 2, 3, 4)).save(out, format="PNG")
        data = {"viewportPngBase64": base64.b64encode(out.getvalue()).decode("ascii")}
        old = nodes_mod.PREVIEW_CAPTURE_MAX_PIXELS
        nodes_mod.PREVIEW_CAPTURE_MAX_PIXELS = 4
        try:
            self.assertIsNone(nodes_mod.SculptCanvas()._preview_from_viewport_capture(data))
        finally:
            nodes_mod.PREVIEW_CAPTURE_MAX_PIXELS = old


class TestSculptCanvasExportMesh(unittest.TestCase):
    def test_invalid_json_raises(self):
        node = nodes_mod.SculptCanvas()
        with self.assertRaises(RuntimeError):
            node.export_mesh("sphere", 2, _sculpt_data="{not json")

    def test_malformed_mesh_raises_instead_of_silent_fallback(self):
        node = nodes_mod.SculptCanvas()
        payload = {
            "vertices": [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            "faces": [0, 1, 2, 0],
        }
        with self.assertRaises(RuntimeError):
            node.export_mesh("sphere", 2, _sculpt_data=json.dumps(payload))

    def test_missing_mesh_ref_raises(self):
        node = nodes_mod.SculptCanvas()
        payload = {"_meshOmittedFromWorkflow": True, "_meshRef": "c" * 64}
        with self.assertRaises(RuntimeError):
            node.export_mesh("sphere", 2, _sculpt_data=json.dumps(payload))

    def test_stub_without_any_ref_raises_instead_of_exporting_primitive(self):
        """Persistence never completed: the sculpt is unrecoverable.

        Exporting the placeholder primitive here silently hands back a
        different model than the one the user sculpted.
        """
        node = nodes_mod.SculptCanvas()
        payload = {
            "schemaVersion": 5,
            "_meshOmittedFromWorkflow": True,
            "vertexCount": 250_000,
            "faceCount": 480_000,
        }
        with self.assertRaises(RuntimeError) as ctx:
            node.export_mesh("sphere", 2, _sculpt_data=json.dumps(payload))
        self.assertIn("too large to embed", str(ctx.exception))

    def test_empty_data_still_exports_the_primitive(self):
        """A fresh node with no sculpt must keep falling back silently."""
        node = nodes_mod.SculptCanvas()
        for raw in ("{}", "", "   "):
            obj, _, path = node.export_mesh("cube", 1, _sculpt_data=raw)
            self.assertEqual(path, "")
            self.assertIn("v ", obj)


class TestSculptCanvasIsChanged(unittest.TestCase):
    def test_same_inputs_same_hash(self):
        a = nodes_mod.SculptCanvas.IS_CHANGED(
            primitive="sphere", subdivision=3, _sculpt_data='{"a":1}'
        )
        b = nodes_mod.SculptCanvas.IS_CHANGED(
            primitive="sphere", subdivision=3, _sculpt_data='{"a":1}'
        )
        self.assertEqual(a, b)

    def test_different_data_different_hash(self):
        a = nodes_mod.SculptCanvas.IS_CHANGED(_sculpt_data="{}")
        b = nodes_mod.SculptCanvas.IS_CHANGED(_sculpt_data='{"x":1}')
        self.assertNotEqual(a, b)



def _tiny_png(width=2, height=2):
    from PIL import Image
    img = Image.new("RGBA", (width, height), (200, 40, 40, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _parse_glb(blob):
    import struct
    magic, version, total = struct.unpack("<III", blob[:12])
    json_len, json_type = struct.unpack("<II", blob[12:20])
    doc = json.loads(blob[20:20 + json_len].decode("utf-8"))
    bin_off = 20 + json_len
    bin_len, bin_type = struct.unpack("<II", blob[bin_off:bin_off + 8])
    binary = blob[bin_off + 8:bin_off + 8 + bin_len]
    return {"magic": magic, "version": version, "total": total, "json_type": json_type,
            "bin_type": bin_type, "doc": doc, "bin": binary}


class TestExportWriters(unittest.TestCase):
    V = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    F = [0, 1, 2]
    UV = [0.0, 0.0, 1.0, 0.0, 0.0, 1.0]

    def test_obj_adds_uvs_and_material_only_when_available(self):
        node = nodes_mod.SculptCanvas()
        plain = node._to_obj(self.V, self.F)
        self.assertNotIn("vt ", plain)
        self.assertNotIn("mtllib", plain)
        self.assertIn("f 1//1 2//2 3//3", plain)

        with_uv = node._to_obj(self.V, self.F, self.UV)
        self.assertIn("vt 1.000000 0.000000", with_uv)
        self.assertIn("f 1/1/1 2/2/2 3/3/3", with_uv)
        self.assertNotIn("mtllib", with_uv)

        textured = node._to_obj(self.V, self.F, self.UV, "x.mtl")
        self.assertIn("mtllib x.mtl", textured)
        self.assertIn("usemtl sculpt_material", textured)
        self.assertIn("map_Kd tex.png", nodes_mod._to_mtl_text("tex.png"))

    def test_stl_binary_layout(self):
        blob = nodes_mod._to_stl_bytes(self.V, self.F)
        self.assertEqual(len(blob), 80 + 4 + 50)
        import struct
        self.assertEqual(struct.unpack("<I", blob[80:84])[0], 1)
        normal = struct.unpack("<fff", blob[84:96])
        self.assertAlmostEqual(normal[2], 1.0, places=5)

    def test_glb_structure_flips_v_and_is_untextured_without_png(self):
        parsed = _parse_glb(nodes_mod._to_glb_bytes(self.V, self.F, self.UV))
        self.assertEqual(parsed["magic"], 0x46546C67)
        self.assertEqual(parsed["version"], 2)
        self.assertEqual(parsed["json_type"], 0x4E4F534A)
        self.assertEqual(parsed["bin_type"], 0x004E4942)
        self.assertEqual(parsed["total"] % 4, 0)
        doc = parsed["doc"]
        prim = doc["meshes"][0]["primitives"][0]
        self.assertEqual(set(prim["attributes"]), {"POSITION", "NORMAL", "TEXCOORD_0"})
        self.assertNotIn("images", doc)
        self.assertNotIn("baseColorTexture", doc["materials"][0]["pbrMetallicRoughness"])
        pos = doc["accessors"][prim["attributes"]["POSITION"]]
        self.assertEqual(pos["count"], 3)
        self.assertEqual(pos["min"], [0.0, 0.0, 0.0])
        self.assertEqual(pos["max"], [1.0, 1.0, 0.0])
        idx = doc["accessors"][prim["indices"]]
        self.assertEqual((idx["componentType"], idx["count"]), (5125, 3))
        uv_view = doc["bufferViews"][doc["accessors"][prim["attributes"]["TEXCOORD_0"]]["bufferView"]]
        import struct
        raw = parsed["bin"][uv_view["byteOffset"]:uv_view["byteOffset"] + uv_view["byteLength"]]
        uvs = struct.unpack("<6f", raw)
        # OBJ-style v=0 at the bottom becomes glTF v=1 at the top.
        self.assertEqual(uvs[1], 1.0)
        self.assertEqual(uvs[5], 0.0)

    def test_glb_embeds_png_texture_when_uvs_exist(self):
        png = _tiny_png()
        parsed = _parse_glb(nodes_mod._to_glb_bytes(self.V, self.F, self.UV, png, [0.2, 0.4, 0.6]))
        doc = parsed["doc"]
        self.assertEqual(doc["images"][0]["mimeType"], "image/png")
        self.assertEqual(doc["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"], {"index": 0})
        view = doc["bufferViews"][doc["images"][0]["bufferView"]]
        self.assertEqual(parsed["bin"][view["byteOffset"]:view["byteOffset"] + view["byteLength"]], png)
        # Without UVs a texture cannot be mapped, so it must not be embedded.
        bare = _parse_glb(nodes_mod._to_glb_bytes(self.V, self.F, None, png))["doc"]
        self.assertNotIn("images", bare)

    def test_export_colours_are_written_linear(self):
        # The viewport shows the base colour as display (sRGB) values, while
        # MTL and glTF readers treat the numbers as linear. 0.5 display is
        # about 0.214 linear; writing 0.5 would open as a washed-out 0.735.
        self.assertAlmostEqual(nodes_mod._srgb_to_linear(0.5), 0.214041, places=6)
        self.assertEqual(nodes_mod._srgb_to_linear(0.0), 0.0)
        self.assertEqual(nodes_mod._srgb_to_linear(1.0), 1.0)
        doc = _parse_glb(nodes_mod._to_glb_bytes(self.V, self.F, None, None, [0.5, 0.2, 1.0]))["doc"]
        factor = doc["materials"][0]["pbrMetallicRoughness"]["baseColorFactor"]
        self.assertAlmostEqual(factor[0], 0.214041, places=6)
        self.assertAlmostEqual(factor[1], 0.033105, places=6)
        self.assertEqual(factor[2:], [1.0, 1.0])

    def test_validate_inputs_checks_export_widgets(self):
        V = nodes_mod.SculptCanvas.VALIDATE_INPUTS
        self.assertIs(V(_sculpt_data="{}", preview_size=512, export_format="glb", filename_prefix="a"), True)
        self.assertIn("preview_size", V(_sculpt_data="{}", preview_size=nodes_mod.PREVIEW_SIZE_MAX + 1))
        self.assertIn("preview_size", V(_sculpt_data="{}", preview_size=True))
        self.assertIn("export_format", V(_sculpt_data="{}", export_format="fbx"))
        self.assertIn("filename_prefix", V(_sculpt_data="{}", filename_prefix="   "))
        self.assertIn("texture", V(_sculpt_data='{"_textureRef": "nope!"}'))

    def test_is_changed_tracks_export_settings(self):
        C = nodes_mod.SculptCanvas.IS_CHANGED
        base = C(_sculpt_data="{}")
        self.assertNotEqual(base, C(_sculpt_data="{}", export_format="glb"))
        self.assertNotEqual(base, C(_sculpt_data="{}", preview_size=1024))
        self.assertNotEqual(base, C(_sculpt_data="{}", filename_prefix="other"))
        self.assertEqual(base, C(_sculpt_data="{}", export_format="none", preview_size=512, filename_prefix="sculpt"))

    def test_write_export_uses_the_output_folder_and_writes_companions(self):
        import tempfile
        import types
        tmp = tempfile.TemporaryDirectory()
        stub = types.ModuleType("folder_paths")
        stub.get_output_directory = lambda: tmp.name
        stub.get_save_image_path = lambda prefix, out, *a: (
            os.path.join(out, os.path.dirname(prefix)), os.path.basename(prefix), 1,
            os.path.dirname(prefix), prefix,
        )
        prev = sys.modules.get("folder_paths")
        sys.modules["folder_paths"] = stub
        try:
            node = nodes_mod.SculptCanvas()
            png = _tiny_png()
            obj_path = node._write_export("obj", "demo", self.V, self.F, self.UV, png, [0.5, 0.5, 0.5])
            self.assertTrue(obj_path.endswith("demo_00001_.obj"))
            folder = os.path.dirname(obj_path)
            self.assertTrue(os.path.isfile(os.path.join(folder, "demo_00001_.mtl")))
            self.assertTrue(os.path.isfile(os.path.join(folder, "demo_00001_.png")))
            with open(obj_path, "r", encoding="utf-8") as f:
                self.assertIn("mtllib demo_00001_.mtl", f.read())

            glb_path = node._write_export("glb", "demo", self.V, self.F, self.UV, png, None)
            with open(glb_path, "rb") as f:
                self.assertEqual(f.read(4), b"glTF")
            stl_path = node._write_export("stl", "demo", self.V, self.F, None, None, None)
            self.assertEqual(os.path.getsize(stl_path), 134)

            # The full node path returns the written file as mesh_path.
            payload = json.dumps({"vertices": self.V, "faces": self.F, "uvs": self.UV})
            obj_text, _preview, path = node.export_mesh(
                "sphere", 1, _sculpt_data=payload, export_format="stl", filename_prefix="demo"
            )
            self.assertIn("vt ", obj_text)
            self.assertTrue(path.endswith(".stl"))
            _, _, none_path = node.export_mesh("sphere", 1, _sculpt_data=payload)
            self.assertEqual(none_path, "")
        finally:
            if prev is not None:
                sys.modules["folder_paths"] = prev
            else:
                sys.modules.pop("folder_paths", None)
            tmp.cleanup()

    def test_textured_export_fails_loudly_when_texture_ref_is_missing(self):
        node = nodes_mod.SculptCanvas()
        payload = json.dumps({"vertices": self.V, "faces": self.F, "uvs": self.UV, "_textureRef": "a" * 64})
        with self.assertRaises(RuntimeError) as ctx:
            node.export_mesh("sphere", 1, _sculpt_data=payload, export_format="glb")
        self.assertIn("texture", str(ctx.exception).lower())
        # Geometry-only formats never need the texture, so the same payload exports.
        _, _, path = node.export_mesh("sphere", 1, _sculpt_data=payload, export_format="none")
        self.assertEqual(path, "")

    def test_untextured_obj_still_writes_material_colour(self):
        import tempfile
        import types
        tmp = tempfile.TemporaryDirectory()
        stub = types.ModuleType("folder_paths")
        stub.get_output_directory = lambda: tmp.name
        stub.get_save_image_path = lambda prefix, out, *a: (out, prefix, 3, "", prefix)
        prev = sys.modules.get("folder_paths")
        sys.modules["folder_paths"] = stub
        try:
            node = nodes_mod.SculptCanvas()
            obj_path = node._write_export("obj", "plain", self.V, self.F, None, None, [0.7, 0.24, 0.17])
            with open(obj_path, "r", encoding="utf-8") as f:
                obj_text = f.read()
            self.assertIn("mtllib plain_00003_.mtl", obj_text)
            self.assertIn("usemtl sculpt_material", obj_text)
            with open(os.path.join(tmp.name, "plain_00003_.mtl"), "r", encoding="utf-8") as f:
                mtl = f.read()
            # Written linear: Blender reads MTL colours as scene-linear.
            self.assertIn("Kd 0.4480 0.0470 0.0245", mtl)
            self.assertNotIn("map_Kd", mtl)
            self.assertFalse(os.path.exists(os.path.join(tmp.name, "plain_00003_.png")))
        finally:
            if prev is not None:
                sys.modules["folder_paths"] = prev
            else:
                sys.modules.pop("folder_paths", None)
            tmp.cleanup()

    def test_preview_size_controls_cpu_fallback_resolution(self):
        node = nodes_mod.SculptCanvas()
        _, preview, _ = node.export_mesh("sphere", 1, _sculpt_data="{}", preview_size=256)
        self.assertEqual(tuple(preview.shape), (1, 256, 256, 4))


class TestHardening(unittest.TestCase):
    V = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
    F = [0, 1, 2]

    def test_uv_magnitude_is_bounded(self):
        payload = json.dumps({"vertices": self.V, "faces": self.F, "uvs": [1e300, 0, 0, 0, 0, 0]})
        err = nodes_mod.SculptCanvas.VALIDATE_INPUTS(_sculpt_data=payload)
        self.assertIsInstance(err, str)
        self.assertIn("uvs", err)

    def test_non_json_decode_errors_are_reported_not_raised(self):
        err = nodes_mod.SculptCanvas.VALIDATE_INPUTS(_sculpt_data="1" * 5000)
        self.assertIsInstance(err, str)
        node = nodes_mod.SculptCanvas()
        with self.assertRaises(RuntimeError):
            node.export_mesh("sphere", 1, _sculpt_data="1" * 5000)

    def test_filename_prefix_rejects_filesystem_hostile_characters(self):
        for bad in ("a?b", "x<y", 'q"r', "tab\there", "colon:name"):
            self.assertIsInstance(nodes_mod.SculptCanvas.VALIDATE_INPUTS(filename_prefix=bad), str, bad)
        self.assertIs(nodes_mod.SculptCanvas.VALIDATE_INPUTS(filename_prefix="sub/my_model-2"), True)

    def test_export_write_failures_become_runtime_errors(self):
        import tempfile
        import types
        tmp = tempfile.TemporaryDirectory()
        stub = types.ModuleType("folder_paths")
        stub.get_output_directory = lambda: tmp.name
        # Point the export at a folder path that is an existing file, so makedirs fails.
        blocker = os.path.join(tmp.name, "blocked")
        with open(blocker, "w", encoding="utf-8") as f:
            f.write("x")
        stub.get_save_image_path = lambda prefix, out, *a: (blocker, prefix, 1, "", prefix)
        prev = sys.modules.get("folder_paths")
        sys.modules["folder_paths"] = stub
        try:
            node = nodes_mod.SculptCanvas()
            with self.assertRaises(RuntimeError) as ctx:
                node._write_export("stl", "demo", self.V, self.F, None, None, None)
            self.assertIn("export", str(ctx.exception).lower())
        finally:
            if prev is not None:
                sys.modules["folder_paths"] = prev
            else:
                sys.modules.pop("folder_paths", None)
            tmp.cleanup()

    def test_viewport_capture_must_be_png(self):
        node = nodes_mod.SculptCanvas()
        not_png = base64.b64encode(b"BM" + b"\0" * 64).decode("ascii")
        self.assertIsNone(node._preview_from_viewport_capture({"viewportPngBase64": not_png}))


if __name__ == "__main__":
    unittest.main()
