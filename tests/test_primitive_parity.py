"""Cross-language parity contract, Python side.

The Python primitive generators (used when a queue has no sculpt data) must
produce the same meshes the viewport shows, and backend/frontend limits must
agree. tests/primitiveParity.test.js asserts the same fixture from the JS side.
"""

import json
import importlib.util
import os
import re
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

FIXTURE_PATH = os.path.join(os.path.dirname(__file__), "fixtures", "primitive_parity.json")
LIMITS_JS_PATH = os.path.join(ROOT, "js", "engine", "limits.js")

PRIMITIVES = ("sphere", "cube", "cylinder", "torus", "plane")
SUBDIVISIONS = (1, 2, 3, 4, 5)
BBOX_TOLERANCE = 1e-4


class TestPrimitiveParityFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(FIXTURE_PATH, "r", encoding="utf-8") as f:
            cls.fixture = json.load(f)
        cls.node = nodes_mod.SculptCanvas()

    def test_fixture_covers_all_primitives(self):
        expected_keys = {f"{p}:{s}" for p in PRIMITIVES for s in SUBDIVISIONS}
        self.assertEqual(set(self.fixture.keys()), expected_keys)

    def test_python_generators_match_fixture(self):
        for prim in PRIMITIVES:
            for sub in SUBDIVISIONS:
                with self.subTest(primitive=prim, subdivision=sub):
                    v, f = self.node._generate_primitive(prim, sub)
                    expected = self.fixture[f"{prim}:{sub}"]
                    self.assertEqual(len(v) // 3, expected["vertexCount"])
                    self.assertEqual(len(f), expected["faceIndexCount"])
                    self.assertEqual(sum(f), expected["faceIndexSum"])
                    bbox = [
                        min(v[0::3]), min(v[1::3]), min(v[2::3]),
                        max(v[0::3]), max(v[1::3]), max(v[2::3]),
                    ]
                    for got, want in zip(bbox, expected["bbox"]):
                        self.assertAlmostEqual(got, want, delta=BBOX_TOLERANCE)

    def test_closed_primitives_are_welded_manifolds(self):
        for prim in ("sphere", "cube", "cylinder", "torus"):
            with self.subTest(primitive=prim):
                vertices, faces = self.node._generate_primitive(prim, 3)
                positions = {
                    tuple(round(vertices[i + axis] * 10_000_000) for axis in range(3))
                    for i in range(0, len(vertices), 3)
                }
                self.assertEqual(len(positions), len(vertices) // 3)
                edge_use = {}
                for i in range(0, len(faces), 3):
                    triangle = faces[i:i + 3]
                    for edge in range(3):
                        key = tuple(sorted((triangle[edge], triangle[(edge + 1) % 3])))
                        edge_use[key] = edge_use.get(key, 0) + 1
                self.assertTrue(edge_use)
                self.assertTrue(all(count == 2 for count in edge_use.values()))


class TestLimitContract(unittest.TestCase):
    def test_frontend_import_limit_matches_backend(self):
        with open(LIMITS_JS_PATH, "r", encoding="utf-8") as f:
            src = f.read()
        match = re.search(r"MAX_IMPORT_VERTEX_COUNT\s*=\s*(\d+)", src)
        self.assertIsNotNone(match, "MAX_IMPORT_VERTEX_COUNT not found in limits.js")
        self.assertEqual(int(match.group(1)), nodes_mod.MAX_MESH_VERTICES)

    def test_preview_size_and_export_formats_match_frontend(self):
        with open(LIMITS_JS_PATH, "r", encoding="utf-8") as f:
            src = f.read()
        for name in ("PREVIEW_SIZE_MIN", "PREVIEW_SIZE_MAX", "PREVIEW_SIZE_DEFAULT",
                     "SUBDIVISION_MIN", "SUBDIVISION_MAX"):
            match = re.search(name + r"\s*=\s*(\d+)", src)
            self.assertIsNotNone(match, name + " not found in limits.js")
            self.assertEqual(int(match.group(1)), getattr(nodes_mod, name), name)
        match = re.search(r"EXPORT_FORMATS\s*=\s*\[([^\]]*)\]", src)
        self.assertIsNotNone(match, "EXPORT_FORMATS not found in limits.js")
        frontend = tuple(x.strip().strip('"') for x in match.group(1).split(",") if x.strip())
        self.assertEqual(frontend, nodes_mod.EXPORT_FORMATS)
        match = re.search(r"PRIMITIVE_TYPES\s*=\s*\[([^\]]*)\]", src)
        self.assertIsNotNone(match, "PRIMITIVE_TYPES not found in limits.js")
        frontend = tuple(x.strip().strip('"') for x in match.group(1).split(",") if x.strip())
        self.assertEqual(frontend, nodes_mod.PRIMITIVE_TYPES)


if __name__ == "__main__":
    unittest.main()
