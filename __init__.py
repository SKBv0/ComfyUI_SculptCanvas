"""
Sculpt Canvas - interactive mesh sculpting node for ComfyUI
"""

import logging

from .nodes import SculptCanvas

def _register_sculpt_routes():
    """Register /sculpt HTTP routes when a ComfyUI server is available.

    Running with no server (unit tests, static import checks) is expected and
    only logged. An error raised from inside sculpt_server is re-raised, since
    otherwise the node would look healthy while large-mesh persistence is dead.
    """
    try:
        import server as _server_mod
    except ImportError:
        logging.info("Sculpt Canvas: no ComfyUI server module; persistence routes disabled")
        return
    instance = getattr(getattr(_server_mod, "PromptServer", None), "instance", None)
    if instance is None or not hasattr(instance, "routes"):
        logging.info("Sculpt Canvas: PromptServer not initialized; persistence routes disabled")
        return
    try:
        from . import sculpt_server  # noqa: F401  registers /sculpt HTTP routes
    except Exception:
        logging.exception(
            "Sculpt Canvas: FAILED to register /sculpt routes: meshes over the "
            "workflow-embed limit will NOT persist across reloads"
        )
        raise


_register_sculpt_routes()

NODE_CLASS_MAPPINGS = {
    "SculptCanvas": SculptCanvas,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SculptCanvas": "Sculpt Canvas",
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
