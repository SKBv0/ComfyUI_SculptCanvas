"""End-to-end tests for the /sculpt/mesh persistence routes.

Runs against a stubbed PromptServer + aiohttp TestClient, so no ComfyUI server
process is needed. Skipped automatically when aiohttp is unavailable.
"""

import asyncio
import hashlib
import importlib.util
import io
import json
import math
import os
import sys
import tempfile
import threading
import time
import types
import unittest

PKG_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

try:
    from aiohttp import web
    from aiohttp.test_utils import TestClient, TestServer
    HAS_AIOHTTP = True
except ImportError:
    HAS_AIOHTTP = False

SMALL_MESH = {
    "schemaVersion": 5,
    "vertices": [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
    "faces": [0, 1, 2],
}


def _load_package_with_stubs(user_dir):
    """Import the package the way ComfyUI does, with server/folder_paths stubbed."""
    server_stub = types.ModuleType("server")

    class PromptServer:
        pass

    instance = PromptServer()
    instance.routes = web.RouteTableDef()
    PromptServer.instance = instance
    server_stub.PromptServer = PromptServer

    fp_stub = types.ModuleType("folder_paths")
    fp_stub.get_user_directory = lambda: user_dir
    fp_stub.get_output_directory = lambda: os.path.join(user_dir, "output")
    fp_stub.get_save_image_path = lambda prefix, out, *a: (out, prefix, 1, "", prefix)

    sys.modules["server"] = server_stub
    sys.modules["folder_paths"] = fp_stub

    pkg_name = "comfyui_sculpt_route_test"
    spec = importlib.util.spec_from_file_location(
        pkg_name,
        os.path.join(PKG_ROOT, "__init__.py"),
        submodule_search_locations=[PKG_ROOT],
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[pkg_name] = module
    spec.loader.exec_module(module)
    return pkg_name, module, instance


def _cleanup_stubs(pkg_name):
    for name in (pkg_name, f"{pkg_name}.nodes", f"{pkg_name}.sculpt_server", "server", "folder_paths"):
        sys.modules.pop(name, None)


@unittest.skipUnless(HAS_AIOHTTP, "aiohttp not available")
class TestSculptMeshRoutes(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.pkg_name, self.module, self.instance = _load_package_with_stubs(self._tmp.name)
        self.node_cls = self.module.NODE_CLASS_MAPPINGS["SculptCanvas"]
        # Match ComfyUI: client_max_size defaults to 100 MiB (--max-upload-size)
        app = web.Application(client_max_size=100 * 1024 * 1024)
        app.add_routes(self.instance.routes)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        _cleanup_stubs(self.pkg_name)
        self._tmp.cleanup()

    async def test_get_and_release_do_not_block_event_loop_on_store_lock(self):
        ss = sys.modules[f"{self.pkg_name}.sculpt_server"]
        response = await self.client.post("/sculpt/mesh", json=SMALL_MESH)
        ref = (await response.json())["ref"]
        for method, path in [("get", f"/sculpt/mesh/{ref}"),
                             ("delete", f"/sculpt/session/{'a' * 32}")]:
            held, release = threading.Event(), threading.Event()

            def hold_lock():
                with ss._STORE_LOCK:
                    held.set()
                    release.wait(timeout=1.5)

            worker = threading.Thread(target=hold_lock)
            worker.start()
            self.assertTrue(held.wait(timeout=1))
            pending = asyncio.create_task(getattr(self.client, method)(path))
            try:
                start = time.monotonic()
                await asyncio.sleep(0.05)
                self.assertLess(time.monotonic() - start, 0.5, method)
            finally:
                release.set()
                await asyncio.to_thread(worker.join)
                result = await pending
                await result.read()
            self.assertIn(result.status, (200, 204))

    async def test_invalid_utf8_is_a_client_error(self):
        result = await self.client.post(
            "/sculpt/mesh",
            data=b"\xff\xfe\xff",
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(result.status, 400)

    async def test_mesh_route_rejects_non_json_content_type(self):
        result = await self.client.post(
            "/sculpt/mesh", data=json.dumps(SMALL_MESH), headers={"Content-Type": "text/plain"}
        )
        self.assertEqual(result.status, 415)

    async def test_save_is_content_addressed_and_idempotent(self):
        res = await self.client.post("/sculpt/mesh", json=SMALL_MESH)
        self.assertEqual(res.status, 200, await res.text())
        ref = (await res.json())["ref"]
        self.assertRegex(ref, r"^[0-9a-f]{64}$")

        res = await self.client.post(
            "/sculpt/mesh",
            data=json.dumps(SMALL_MESH).encode(),
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(res.status, 200)
        self.assertEqual((await res.json())["ref"], ref)

        res = await self.client.get(f"/sculpt/mesh/{ref}")
        self.assertEqual(res.status, 200)
        self.assertEqual((await res.json())["faces"], [0, 1, 2])

    async def test_invalid_and_missing_refs_rejected(self):
        res = await self.client.get("/sculpt/mesh/notahash!!")
        self.assertIn(res.status, (400, 404))
        res = await self.client.get("/sculpt/mesh/" + "f" * 64)
        self.assertEqual(res.status, 404)

    async def test_corrupt_content_addressed_file_is_rejected(self):
        res = await self.client.post("/sculpt/mesh", json=SMALL_MESH)
        ref = (await res.json())["ref"]
        nodes_mod = sys.modules[f"{self.pkg_name}.nodes"]
        path = os.path.join(nodes_mod._mesh_store_dir(), f"{ref}.json")
        with open(path, "ab") as file:
            file.write(b" ")
        res = await self.client.get(f"/sculpt/mesh/{ref}")
        self.assertEqual(res.status, 409)

        # Re-uploading identical content must repair the corrupt file instead
        # of returning 200 with a reference that still fails on GET.
        res = await self.client.post("/sculpt/mesh", json=SMALL_MESH)
        self.assertEqual(res.status, 200, await res.text())
        self.assertEqual((await res.json())["ref"], ref)
        res = await self.client.get(f"/sculpt/mesh/{ref}")
        self.assertEqual(res.status, 200, await res.text())

    async def test_invalid_mesh_body_rejected(self):
        res = await self.client.post(
            "/sculpt/mesh", json={"vertices": [0, 0, 0], "faces": [0, 1, 2, 3]}
        )
        self.assertEqual(res.status, 400)
        res = await self.client.post(
            "/sculpt/mesh", data=b"{not json", headers={"Content-Type": "application/json"}
        )
        self.assertEqual(res.status, 400)
        res = await self.client.post("/sculpt/mesh", json={"schemaVersion": 5})
        self.assertEqual(res.status, 400)

    async def test_large_multi_chunk_body_roundtrips_intact(self):
        # StreamReader.read(n) can return after the first network chunk, so the
        # handler must keep reading until it has the complete body.
        n = 60000
        verts = []
        for i in range(n):
            a = i * 0.01
            verts.extend([math.cos(a), math.sin(a), a * 0.001])
        faces = []
        for i in range(0, n - 2, 3):
            faces.extend([i, i + 1, i + 2])
        body = json.dumps(
            {"schemaVersion": 5, "vertices": verts, "faces": faces}
        ).encode()
        self.assertGreater(len(body), 2_000_000)

        res = await self.client.post(
            "/sculpt/mesh",
            data=io.BytesIO(body),
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(res.status, 200, await res.text())
        ref = (await res.json())["ref"]
        res = await self.client.get(f"/sculpt/mesh/{ref}")
        self.assertEqual(res.status, 200)
        loaded = await res.json()
        self.assertEqual(len(loaded["vertices"]), n * 3)

    async def test_chunked_body_is_rejected_at_route_limit(self):
        ss = sys.modules[f"{self.pkg_name}.sculpt_server"]
        old_limit = ss.MAX_SCULPT_DATA_BYTES
        try:
            ss.MAX_SCULPT_DATA_BYTES = 64

            async def chunks():
                yield b"x" * 40
                yield b"y" * 40

            res = await self.client.post(
                "/sculpt/mesh",
                data=chunks(),
                headers={"Content-Type": "application/json"},
            )
            self.assertEqual(res.status, 413, await res.text())
        finally:
            ss.MAX_SCULPT_DATA_BYTES = old_limit

    async def test_execution_resolves_mesh_ref_from_store(self):
        res = await self.client.post("/sculpt/mesh", json=SMALL_MESH)
        ref = (await res.json())["ref"]

        stub = json.dumps(
            {"schemaVersion": 5, "_meshOmittedFromWorkflow": True, "_meshRef": ref}
        )
        self.assertIs(self.node_cls.VALIDATE_INPUTS(_sculpt_data=stub), True)
        node = self.node_cls()
        obj, _preview, _path = node.export_mesh("sphere", 2, _sculpt_data=stub)
        self.assertEqual(obj.count("\nv "), 3, "expected the stored 3-vertex mesh, not a primitive")

    async def test_prune_protects_workflow_referenced_meshes(self):
        ss = sys.modules[f"{self.pkg_name}.sculpt_server"]
        nodes_mod = sys.modules[f"{self.pkg_name}.nodes"]
        base = nodes_mod._mesh_store_dir(create=True)

        total = ss.MAX_STORED_MESHES + 2
        refs = [format(i, "064x") for i in range(total)]
        now = time.time()
        for i, ref in enumerate(refs):
            path = os.path.join(base, f"{ref}.json")
            with open(path, "w", encoding="utf-8") as f:
                f.write("{}")
            stamp = now - (total - i)  # index 0 is oldest
            os.utime(path, (stamp, stamp))

        # A saved workflow references the oldest mesh (stub is an escaped
        # string inside widgets_values, like real workflow JSON).
        wf_dir = os.path.join(self._tmp.name, "default", "workflows")
        os.makedirs(wf_dir, exist_ok=True)
        stub = json.dumps({"schemaVersion": 5, "_meshOmittedFromWorkflow": True, "_meshRef": refs[0]})
        workflow = {"nodes": [{"type": "SculptCanvas", "widgets_values": ["sphere", 4, "viewport", stub]}]}
        with open(os.path.join(wf_dir, "wf.json"), "w", encoding="utf-8") as f:
            json.dump(workflow, f)

        ss._prune_store(base)
        remaining = set(os.listdir(base))
        self.assertIn(f"{refs[0]}.json", remaining, "workflow-referenced mesh must survive pruning")
        self.assertNotIn(f"{refs[1]}.json", remaining)
        self.assertNotIn(f"{refs[2]}.json", remaining)
        self.assertEqual(len(remaining), ss.MAX_STORED_MESHES)

    async def test_workflow_scan_has_no_arbitrary_500_file_dead_end(self):
        ss = sys.modules[f"{self.pkg_name}.sculpt_server"]
        wf_dir = os.path.join(self._tmp.name, "default", "workflows")
        os.makedirs(wf_dir, exist_ok=True)
        target_ref = "a" * 64
        for i in range(501):
            with open(os.path.join(wf_dir, f"wf-{i:04d}.json"), "w", encoding="utf-8") as file:
                json.dump({"_meshRef": target_ref if i == 500 else None}, file)

        refs, complete = ss._collect_workflow_refs()
        self.assertTrue(complete)
        self.assertIn(target_ref, refs)

    async def test_large_workflow_is_scanned_in_chunks(self):
        ss = sys.modules[f"{self.pkg_name}.sculpt_server"]
        wf_dir = os.path.join(self._tmp.name, "default", "workflows")
        os.makedirs(wf_dir, exist_ok=True)
        path = os.path.join(wf_dir, "oversized.json")
        target_ref = "b" * 64
        with open(path, "wb") as file:
            file.write(b" " * (ss._WORKFLOW_SCAN_CHUNK_BYTES + 17))
            file.write(json.dumps({"_meshRef": target_ref}).encode("utf-8"))
        refs, complete = ss._collect_workflow_refs()
        self.assertTrue(complete)
        self.assertIn(target_ref, refs)

    async def test_full_protected_store_rejects_new_mesh_instead_of_returning_dead_ref(self):
        ss = sys.modules[f"{self.pkg_name}.sculpt_server"]
        nodes_mod = sys.modules[f"{self.pkg_name}.nodes"]
        old_max = ss.MAX_STORED_MESHES
        ss.MAX_STORED_MESHES = 2
        try:
            base = nodes_mod._mesh_store_dir(create=True)
            refs = ["1" * 64, "2" * 64]
            for ref in refs:
                with open(os.path.join(base, f"{ref}.json"), "w", encoding="utf-8") as file:
                    file.write("{}")
            wf_dir = os.path.join(self._tmp.name, "default", "workflows")
            os.makedirs(wf_dir, exist_ok=True)
            workflow = {"nodes": [{"widgets_values": [json.dumps({"_meshRef": ref}) for ref in refs]}]}
            with open(os.path.join(wf_dir, "protected.json"), "w", encoding="utf-8") as file:
                json.dump(workflow, file)

            res = await self.client.post("/sculpt/mesh", json=SMALL_MESH)
            self.assertEqual(res.status, 507, await res.text())
            self.assertEqual(set(os.listdir(base)), {f"{ref}.json" for ref in refs})
        finally:
            ss.MAX_STORED_MESHES = old_max

    async def test_byte_quota_prunes_oldest_unreferenced_mesh(self):
        ss = sys.modules[f"{self.pkg_name}.sculpt_server"]
        nodes_mod = sys.modules[f"{self.pkg_name}.nodes"]
        old_max_bytes = ss.MAX_STORED_MESH_BYTES
        try:
            base = nodes_mod._mesh_store_dir(create=True)
            refs = ["1" * 64, "2" * 64, "3" * 64]
            for i, ref in enumerate(refs):
                path = os.path.join(base, f"{ref}.json")
                with open(path, "wb") as file:
                    file.write(b"x" * 10)
                stamp = time.time() + i
                os.utime(path, (stamp, stamp))
            ss.MAX_STORED_MESH_BYTES = 20

            self.assertTrue(ss._prune_store(base))
            self.assertEqual(
                set(os.listdir(base)),
                {f"{refs[1]}.json", f"{refs[2]}.json"},
            )
        finally:
            ss.MAX_STORED_MESH_BYTES = old_max_bytes

    async def test_impossible_byte_quota_does_not_partially_delete_store(self):
        ss = sys.modules[f"{self.pkg_name}.sculpt_server"]
        nodes_mod = sys.modules[f"{self.pkg_name}.nodes"]
        old_max_bytes = ss.MAX_STORED_MESH_BYTES
        try:
            base = nodes_mod._mesh_store_dir(create=True)
            refs = ["4" * 64, "5" * 64]
            for ref in refs:
                with open(os.path.join(base, f"{ref}.json"), "wb") as file:
                    file.write(b"x" * 10)
            ss._LEGACY_REF_LAST_SEEN.update({ref: time.monotonic() for ref in refs})
            ss.MAX_STORED_MESH_BYTES = 10
            before = set(os.listdir(base))

            self.assertFalse(ss._prune_store(base))
            self.assertEqual(set(os.listdir(base)), before)
        finally:
            for ref in refs:
                ss._LEGACY_REF_LAST_SEEN.pop(ref, None)
            ss.MAX_STORED_MESH_BYTES = old_max_bytes

    async def test_session_lease_replaces_old_ref_instead_of_exhausting_store(self):
        ss = sys.modules[f"{self.pkg_name}.sculpt_server"]
        nodes_mod = sys.modules[f"{self.pkg_name}.nodes"]
        old_max = ss.MAX_STORED_MESHES
        session_id = "a" * 32
        headers = {"X-Sculpt-Session": session_id}
        try:
            ss.MAX_STORED_MESHES = 2
            refs = []
            for value in range(4):
                mesh = dict(SMALL_MESH)
                mesh["vertices"] = list(SMALL_MESH["vertices"])
                mesh["vertices"][0] = value * 0.1
                res = await self.client.post("/sculpt/mesh", json=mesh, headers=headers)
                self.assertEqual(res.status, 200, await res.text())
                refs.append((await res.json())["ref"])

            base = nodes_mod._mesh_store_dir(create=True)
            stored = [name for name in os.listdir(base) if name.endswith(".json")]
            self.assertLessEqual(len(stored), 2)
            self.assertEqual(ss._SESSION_SLOTS[session_id], refs[-1])
            self.assertNotIn(refs[0], ss._SESSION_SLOTS.values())

            res = await self.client.delete(f"/sculpt/session/{session_id}")
            self.assertEqual(res.status, 204)
            self.assertNotIn(session_id, ss._SESSION_SLOTS)
        finally:
            ss._SESSION_SLOTS.pop(session_id, None)
            ss._SESSION_LAST_SEEN.pop(session_id, None)
            ss.MAX_STORED_MESHES = old_max

    async def test_legacy_clients_have_a_bounded_compatibility_lease(self):
        ss = sys.modules[f"{self.pkg_name}.sculpt_server"]
        nodes_mod = sys.modules[f"{self.pkg_name}.nodes"]
        old_max = ss.MAX_STORED_MESHES
        try:
            ss.MAX_STORED_MESHES = 2
            refs = []
            for value in range(4):
                mesh = dict(SMALL_MESH)
                mesh["vertices"] = list(SMALL_MESH["vertices"])
                mesh["vertices"][0] = value * 0.1
                response = await self.client.post("/sculpt/mesh", json=mesh)
                self.assertEqual(response.status, 200, await response.text())
                refs.append((await response.json())["ref"])

            base = nodes_mod._mesh_store_dir(create=True)
            stored = [name for name in os.listdir(base) if name.endswith(".json")]
            self.assertLessEqual(len(stored), 2)
            self.assertLessEqual(len(ss._LEGACY_REF_LAST_SEEN), 1)
            self.assertIn(refs[-1], ss._LEGACY_REF_LAST_SEEN)
        finally:
            ss._LEGACY_REF_LAST_SEEN.clear()
            ss.MAX_STORED_MESHES = old_max

    async def test_concurrent_uploads_share_one_bounded_session_lease(self):
        ss = sys.modules[f"{self.pkg_name}.sculpt_server"]
        nodes_mod = sys.modules[f"{self.pkg_name}.nodes"]
        old_max = ss.MAX_STORED_MESHES
        session_id = "b" * 32
        headers = {"X-Sculpt-Session": session_id}
        try:
            ss.MAX_STORED_MESHES = 2

            async def upload(value):
                mesh = dict(SMALL_MESH)
                mesh["vertices"] = list(SMALL_MESH["vertices"])
                mesh["vertices"][0] = value * 0.1
                response = await self.client.post(
                    "/sculpt/mesh", json=mesh, headers=headers
                )
                return response.status, await response.text()

            results = await asyncio.gather(*(upload(value) for value in range(6)))
            self.assertTrue(all(status == 200 for status, _ in results), results)
            base = nodes_mod._mesh_store_dir(create=True)
            stored = [name for name in os.listdir(base) if name.endswith(".json")]
            self.assertLessEqual(len(stored), 2)
            self.assertEqual(len(ss._SESSION_SLOTS), 1)
        finally:
            ss._SESSION_SLOTS.pop(session_id, None)
            ss._SESSION_LAST_SEEN.pop(session_id, None)
            ss.MAX_STORED_MESHES = old_max

    async def test_abandoned_session_lease_expires_without_unprotecting_workflows(self):
        ss = sys.modules[f"{self.pkg_name}.sculpt_server"]
        session_id = "c" * 32
        ref = "d" * 64
        ss._SESSION_SLOTS[session_id] = ref
        ss._SESSION_LAST_SEEN[session_id] = 10.0

        ss._expire_session_slots(now=10.0 + ss.SESSION_LEASE_TTL_SECONDS + 1.0)

        self.assertNotIn(session_id, ss._SESSION_SLOTS)
        self.assertNotIn(session_id, ss._SESSION_LAST_SEEN)

    async def test_abandoned_atomic_temp_files_are_cleaned_without_touching_other_files(self):
        nodes_mod = sys.modules[f"{self.pkg_name}.nodes"]
        base = nodes_mod._mesh_store_dir(create=True)
        abandoned = f"{'e' * 64}.json.{'f' * 12}.tmp"
        unrelated = "keep-me.tmp"
        with open(os.path.join(base, abandoned), "wb") as file:
            file.write(b"partial")
        with open(os.path.join(base, unrelated), "wb") as file:
            file.write(b"user")

        res = await self.client.post("/sculpt/mesh", json=SMALL_MESH)

        self.assertEqual(res.status, 200, await res.text())
        self.assertFalse(os.path.exists(os.path.join(base, abandoned)))
        self.assertTrue(os.path.exists(os.path.join(base, unrelated)))

    async def test_duplicate_module_import_does_not_duplicate_routes(self):
        # Hot-reload helpers re-import custom node modules; route registration
        # must be idempotent or aiohttp add_routes() fails at startup.
        before = len(list(self.instance.routes))
        pkg = sys.modules[self.pkg_name]
        importlib_spec = importlib.util.spec_from_file_location(
            f"{self.pkg_name}_reload",
            os.path.join(PKG_ROOT, "__init__.py"),
            submodule_search_locations=[PKG_ROOT],
        )
        module = importlib.util.module_from_spec(importlib_spec)
        sys.modules[f"{self.pkg_name}_reload"] = module
        try:
            importlib_spec.loader.exec_module(module)
            self.assertEqual(len(list(self.instance.routes)), before)
        finally:
            sys.modules.pop(f"{self.pkg_name}_reload", None)
            sys.modules.pop(f"{self.pkg_name}_reload.nodes", None)
            sys.modules.pop(f"{self.pkg_name}_reload.sculpt_server", None)
        self.assertIs(pkg, sys.modules[self.pkg_name])


if __name__ == "__main__":
    unittest.main()


def _tiny_png():
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGBA", (4, 4), (10, 200, 30, 255)).save(buf, format="PNG")
    return buf.getvalue()


@unittest.skipUnless(HAS_AIOHTTP, "aiohttp not available")
class TestSculptTextureRoute(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.pkg_name, self.module, self.instance = _load_package_with_stubs(self._tmp.name)
        app = web.Application(client_max_size=100 * 1024 * 1024)
        app.add_routes(self.instance.routes)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        _cleanup_stubs(self.pkg_name)
        self._tmp.cleanup()

    async def test_session_leases_are_capped_so_the_store_cannot_be_locked(self):
        ss = sys.modules[f"{self.pkg_name}.sculpt_server"]
        total = ss.MAX_SESSION_LEASES + 6
        for i in range(total):
            mesh = dict(SMALL_MESH, vertices=[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, i / 1000.0])
            response = await self.client.post(
                "/sculpt/mesh", json=mesh, headers={"X-Sculpt-Session": f"{i:032x}"}
            )
            self.assertEqual(response.status, 200, i)
        self.assertLessEqual(len(ss._SESSION_SLOTS), ss.MAX_SESSION_LEASES)
        # The newest sessions survive, the oldest were evicted.
        self.assertIn(f"{total - 1:032x}", ss._SESSION_SLOTS)
        self.assertNotIn(f"{0:032x}", ss._SESSION_SLOTS)

    async def test_oversized_integer_body_is_a_400_not_a_500(self):
        response = await self.client.post(
            "/sculpt/mesh", data="1" * 5000, headers={"Content-Type": "application/json"}
        )
        self.assertEqual(response.status, 400)

    async def test_texture_temp_files_are_cleaned_on_upload(self):
        import io as _io
        from PIL import Image
        nodes = sys.modules[f"{self.pkg_name}.nodes"]
        base = nodes._texture_store_dir(create=True)
        stray = os.path.join(base, "f" * 64 + ".png." + "0" * 12 + ".tmp")
        with open(stray, "wb") as f:
            f.write(b"junk")
        buf = _io.BytesIO()
        Image.new("RGB", (2, 2), (1, 2, 3)).save(buf, "PNG")
        response = await self.client.post(
            "/sculpt/texture", data=buf.getvalue(), headers={"Content-Type": "image/png"}
        )
        self.assertEqual(response.status, 200)
        self.assertFalse(os.path.exists(stray))

    async def test_texture_upload_roundtrip_and_rejections(self):
        png = _tiny_png()
        response = await self.client.post(
            "/sculpt/texture", data=png, headers={"Content-Type": "image/png"}
        )
        self.assertEqual(response.status, 200)
        ref = (await response.json())["ref"]
        self.assertEqual(ref, hashlib.sha256(png).hexdigest())
        nodes = sys.modules[f"{self.pkg_name}.nodes"]
        self.assertEqual(nodes._load_texture_ref(ref), png)

        wrong_type = await self.client.post(
            "/sculpt/texture", data=png, headers={"Content-Type": "application/octet-stream"}
        )
        self.assertEqual(wrong_type.status, 415)
        not_png = await self.client.post(
            "/sculpt/texture", data=b"definitely not a png", headers={"Content-Type": "image/png"}
        )
        self.assertEqual(not_png.status, 400)

    async def test_textured_glb_export_embeds_the_uploaded_atlas(self):
        png = _tiny_png()
        response = await self.client.post(
            "/sculpt/texture", data=png, headers={"Content-Type": "image/png"}
        )
        ref = (await response.json())["ref"]
        node = self.node_cls() if hasattr(self, "node_cls") else self.module.NODE_CLASS_MAPPINGS["SculptCanvas"]()
        payload = json.dumps({
            "schemaVersion": 5,
            "vertices": [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
            "faces": [0, 1, 2],
            "uvs": [0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
            "_textureRef": ref,
        })
        _obj, _preview, path = node.export_mesh(
            "sphere", 1, _sculpt_data=payload, export_format="glb", filename_prefix="tex"
        )
        with open(path, "rb") as f:
            blob = f.read()
        self.assertEqual(blob[:4], b"glTF")
        self.assertIn(b"image/png", blob)
        self.assertIn(png, blob)
