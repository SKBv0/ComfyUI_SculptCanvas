"""Verify the package imports the way ComfyUI loads it (relative imports in
__init__.py), without needing a running ComfyUI server."""

import importlib.util
import os
import sys
import types
import unittest

PKG_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


class TestPackageImport(unittest.TestCase):
    def test_init_registers_node_mappings(self):
        # Stub the ComfyUI server module so route registration is exercised too.
        server_stub = types.ModuleType("server")

        class PromptServer:
            pass

        instance = PromptServer()

        class _Routes:
            def __init__(self):
                self.registered = []

            def _register(self, method, path):
                def decorator(fn):
                    self.registered.append((method, path, fn))
                    return fn
                return decorator

            def post(self, path):
                return self._register("POST", path)

            def get(self, path):
                return self._register("GET", path)

            def delete(self, path):
                return self._register("DELETE", path)

        instance.routes = _Routes()
        PromptServer.instance = instance
        server_stub.PromptServer = PromptServer

        pkg_name = "comfyui_sculpt_import_test"
        had_server = "server" in sys.modules
        prev_server = sys.modules.get("server")
        sys.modules["server"] = server_stub
        try:
            spec = importlib.util.spec_from_file_location(
                pkg_name,
                os.path.join(PKG_ROOT, "__init__.py"),
                submodule_search_locations=[PKG_ROOT],
            )
            module = importlib.util.module_from_spec(spec)
            sys.modules[pkg_name] = module
            spec.loader.exec_module(module)

            self.assertIn("SculptCanvas", module.NODE_CLASS_MAPPINGS)
            self.assertIn("SculptCanvas", module.NODE_DISPLAY_NAME_MAPPINGS)
            self.assertEqual(module.WEB_DIRECTORY, "./js")
            cls = module.NODE_CLASS_MAPPINGS["SculptCanvas"]
            self.assertEqual(cls.RETURN_TYPES, ("STRING", "IMAGE", "STRING"))
            self.assertEqual(
                [(method, path) for method, path, _ in instance.routes.registered],
                [
                    ("POST", "/sculpt/mesh"),
                    ("GET", "/sculpt/mesh/{ref}"),
                    ("DELETE", "/sculpt/session/{session_id}"),
                    ("POST", "/sculpt/texture"),
                ],
            )
        finally:
            sys.modules.pop(pkg_name, None)
            sys.modules.pop(f"{pkg_name}.nodes", None)
            sys.modules.pop(f"{pkg_name}.sculpt_server", None)
            if had_server:
                sys.modules["server"] = prev_server
            else:
                sys.modules.pop("server", None)


if __name__ == "__main__":
    unittest.main()
