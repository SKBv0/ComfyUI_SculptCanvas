"""
HTTP routes for persisting large sculpt meshes server-side.

Meshes above the workflow-embed limit are stored content-addressed (sha256 of
the raw JSON body) under the ComfyUI user directory. The workflow JSON embeds
only the reference hash, so dense sculpts survive a browser/workflow reload.
"""

import asyncio
import hashlib
import json
import logging
import os
import re
import threading
import time

from aiohttp import web
from server import PromptServer

from .nodes import (
    MAX_SCULPT_DATA_BYTES,
    MAX_TEXTURE_BYTES,
    MESH_REF_RE,
    _extract_mesh_payload,
    _mesh_store_dir,
    _texture_store_dir,
    _validate_png_bytes,
)

MAX_STORED_MESHES = 256
MAX_STORED_MESH_BYTES = 2 * 1024 * 1024 * 1024
# Uploaded diffuse atlases only serve the next export, so the texture store
# needs no leases: nothing durable references a texture and LRU pruning is safe.
MAX_STORED_TEXTURES = 64
MAX_STORED_TEXTURE_BYTES = 1024 * 1024 * 1024
# Matches both plain JSON ("_meshRef":"...") and the escaped form embedded in
# workflow widget strings (\"_meshRef\":\"...).
_WORKFLOW_REF_RE = re.compile(rb'\\?"_meshRef\\?"\s*:\s*\\?"([0-9a-f]{16,64})')
_WORKFLOW_SCAN_CHUNK_BYTES = 1024 * 1024
_WORKFLOW_SCAN_OVERLAP_BYTES = 128
_STORE_LOCK = threading.Lock()
# Refs returned or loaded during this server process may belong to open,
# not-yet-saved workflows, so pruning must not invalidate them. Modern clients
# identify a node session; legacy clients receive a small, expiring compatibility
# window instead of pinning every mesh until ComfyUI restarts.
_LEGACY_REF_LAST_SEEN = {}
_SESSION_SLOTS = {}
_SESSION_LAST_SEEN = {}
_SESSION_ID_RE = re.compile(r"[0-9a-f]{32}")
_TEMP_FILE_RE = re.compile(r"[0-9a-f]{64}\.(json|png)\.[0-9a-f]{12}\.tmp")
SESSION_LEASE_TTL_SECONDS = 7 * 24 * 60 * 60
MAX_LEGACY_LEASES = 32
# Live node leases are capped too, otherwise many sessions (or a client that
# invents session ids) can pin the whole store and lock every later upload out.
MAX_SESSION_LEASES = 64


def _expire_session_slots(now=None):
    """Drop abandoned browser leases; saved-workflow refs remain protected."""
    cutoff = (time.monotonic() if now is None else now) - SESSION_LEASE_TTL_SECONDS
    expired = [
        session_id
        for session_id, seen in _SESSION_LAST_SEEN.items()
        if seen < cutoff
    ]
    for session_id in expired:
        _SESSION_LAST_SEEN.pop(session_id, None)
        _SESSION_SLOTS.pop(session_id, None)
    legacy_expired = [
        ref for ref, seen in _LEGACY_REF_LAST_SEEN.items() if seen < cutoff
    ]
    for ref in legacy_expired:
        _LEGACY_REF_LAST_SEEN.pop(ref, None)


def _request_session_id(request):
    session_id = request.headers.get("X-Sculpt-Session", "")
    return session_id if _SESSION_ID_RE.fullmatch(session_id) else None


def _cleanup_abandoned_temp_files(base):
    """Remove only this module's atomic-write leftovers while holding the lock."""
    try:
        for name in os.listdir(base):
            if not _TEMP_FILE_RE.fullmatch(name):
                continue
            try:
                os.remove(os.path.join(base, name))
            except OSError:
                logging.warning("Sculpt: failed to remove abandoned temp file: %s", name)
    except OSError:
        logging.warning("Sculpt: failed to scan mesh temp files", exc_info=True)


def _set_session_ref(session_id, ref):
    """Protect only the latest mesh for a live node session."""
    if session_id:
        _expire_session_slots()
        previous = (
            _SESSION_SLOTS.get(session_id),
            _SESSION_LAST_SEEN.get(session_id),
        )
        _SESSION_SLOTS[session_id] = ref
        _SESSION_LAST_SEEN[session_id] = time.monotonic()
        while len(_SESSION_SLOTS) > MAX_SESSION_LEASES:
            oldest = min(_SESSION_LAST_SEEN, key=_SESSION_LAST_SEEN.get)
            _SESSION_LAST_SEEN.pop(oldest, None)
            _SESSION_SLOTS.pop(oldest, None)
        return previous
    _expire_session_slots()
    _LEGACY_REF_LAST_SEEN[ref] = time.monotonic()
    legacy_limit = max(1, min(MAX_LEGACY_LEASES, MAX_STORED_MESHES - 1))
    while len(_LEGACY_REF_LAST_SEEN) > legacy_limit:
        oldest = min(_LEGACY_REF_LAST_SEEN, key=_LEGACY_REF_LAST_SEEN.get)
        _LEGACY_REF_LAST_SEEN.pop(oldest, None)
    return None


def _restore_session_ref(session_id, previous, expected_ref=None):
    if not session_id:
        return
    if expected_ref is not None and _SESSION_SLOTS.get(session_id) != expected_ref:
        return
    previous_ref, previous_seen = previous
    if previous_ref is None:
        _SESSION_SLOTS.pop(session_id, None)
        _SESSION_LAST_SEEN.pop(session_id, None)
    else:
        _SESSION_SLOTS[session_id] = previous_ref
        _SESSION_LAST_SEEN[session_id] = previous_seen


def _collect_workflow_refs():
    """Return (refs, complete) using bounded-memory workflow scans."""
    refs = set()
    try:
        import folder_paths
    except ImportError:
        return refs, False
    try:
        user_dir = folder_paths.get_user_directory()
        for profile in sorted(os.listdir(user_dir)):
            root = os.path.join(user_dir, profile, "workflows")
            if not os.path.isdir(root):
                continue
            for walk_root, dirs, files in os.walk(root):
                dirs.sort()
                for name in sorted(files):
                    if not name.lower().endswith(".json"):
                        continue
                    path = os.path.join(walk_root, name)
                    try:
                        tail = b""
                        with open(path, "rb") as file:
                            while chunk := file.read(_WORKFLOW_SCAN_CHUNK_BYTES):
                                block = tail + chunk
                                for match in _WORKFLOW_REF_RE.finditer(block):
                                    refs.add(match.group(1).decode("ascii"))
                                tail = block[-_WORKFLOW_SCAN_OVERLAP_BYTES:]
                    except OSError:
                        return refs, False
    except Exception:
        logging.warning("Sculpt: workflow ref scan failed", exc_info=True)
        return refs, False
    return refs, True


def _prune_store(base, extra_protected=()):
    """Enforce count/byte quotas without deleting referenced meshes.

    Deletions are planned before they are applied. If protected meshes make
    either quota impossible, the store is left untouched and False is returned.
    """
    try:
        entries = [
            {
                "path": os.path.join(base, name),
                "ref": os.path.splitext(name)[0],
                "size": os.path.getsize(os.path.join(base, name)),
                "mtime": os.path.getmtime(os.path.join(base, name)),
            }
            for name in os.listdir(base)
            if name.endswith(".json")
        ]
        total_bytes = sum(entry["size"] for entry in entries)
        if (
            len(entries) <= MAX_STORED_MESHES
            and total_bytes <= MAX_STORED_MESH_BYTES
        ):
            return True
        _expire_session_slots()
        protected, complete = _collect_workflow_refs()
        if not complete:
            logging.warning("Sculpt: pruning skipped because a workflow could not be scanned")
            return False
        protected.update(_LEGACY_REF_LAST_SEEN)
        protected.update(_SESSION_SLOTS.values())
        protected.update(extra_protected)
        entries.sort(key=lambda entry: entry["mtime"])
        remaining_count = len(entries)
        remaining_bytes = total_bytes
        removals = []
        for entry in entries:
            if (
                remaining_count <= MAX_STORED_MESHES
                and remaining_bytes <= MAX_STORED_MESH_BYTES
            ):
                break
            if entry["ref"] in protected:
                continue
            removals.append(entry["path"])
            remaining_count -= 1
            remaining_bytes -= entry["size"]

        if (
            remaining_count > MAX_STORED_MESHES
            or remaining_bytes > MAX_STORED_MESH_BYTES
        ):
            return False

        for path in removals:
            os.remove(path)
        return True
    except OSError:
        logging.warning("Sculpt: mesh store pruning failed", exc_info=True)
        return False


def _validate_and_store_mesh(raw, session_id=None):
    """Validate, hash, and persist a body outside aiohttp's event loop."""
    try:
        data = json.loads(raw)
    except (ValueError, RecursionError):
        # JSONDecodeError and UnicodeDecodeError are ValueErrors; oversized
        # integers and absurd nesting raise the other two.
        return None, "invalid JSON", 400
    if not isinstance(data, dict):
        return None, "payload must be a JSON object", 400
    try:
        payload = _extract_mesh_payload(data)
    except ValueError as exc:
        return None, f"invalid mesh: {exc}", 400
    if payload is None:
        return None, "payload contains no mesh", 400

    base = _mesh_store_dir(create=True)
    if base is None:
        return None, "mesh store unavailable", 500
    ref = hashlib.sha256(raw).hexdigest()
    path = os.path.join(base, f"{ref}.json")
    with _STORE_LOCK:
        _cleanup_abandoned_temp_files(base)
        path_exists = os.path.exists(path)
        needs_write = not path_exists or not _stored_ref_matches(path, ref)
        if needs_write:
            if path_exists:
                logging.warning(
                    "Sculpt: replacing corrupt content-addressed mesh during re-upload: %s",
                    ref,
                )
            tmp = f"{path}.{os.urandom(6).hex()}.tmp"
            try:
                with open(tmp, "wb") as file:
                    file.write(raw)
                    file.flush()
                    os.fsync(file.fileno())
                os.replace(tmp, path)
            except OSError:
                logging.error("Sculpt: failed to persist mesh", exc_info=True)
                try:
                    os.remove(tmp)
                except OSError:
                    pass
                return None, "failed to persist mesh", 500
            previous = _set_session_ref(session_id, ref)
            if not _prune_store(base, (ref,)):
                if session_id:
                    _restore_session_ref(session_id, previous, ref)
                else:
                    _LEGACY_REF_LAST_SEEN.pop(ref, None)
                try:
                    os.remove(path)
                except OSError:
                    pass
                return None, "mesh store capacity is exhausted by referenced meshes", 507
        else:
            _set_session_ref(session_id, ref)
            try:
                os.utime(path)
            except OSError:
                pass
    return ref, None, 200


async def sculpt_save_mesh(request):
    if request.content_type != "application/json":
        return web.json_response(
            {"error": "Content-Type must be application/json"}, status=415
        )
    if (
        request.content_length is not None
        and request.content_length > MAX_SCULPT_DATA_BYTES
    ):
        return web.json_response({"error": "mesh payload too large"}, status=413)
    # Stream against our own bound instead of relying on ComfyUI's configurable
    # client_max_size. iter_chunked consumes the complete body, unlike a single
    # StreamReader.read(n), which may return after one network chunk.
    chunks = []
    total = 0
    async for chunk in request.content.iter_chunked(1024 * 1024):
        total += len(chunk)
        if total > MAX_SCULPT_DATA_BYTES:
            return web.json_response({"error": "mesh payload too large"}, status=413)
        chunks.append(chunk)
    raw = b"".join(chunks)
    ref, error, status = await asyncio.to_thread(
        _validate_and_store_mesh, raw, _request_session_id(request)
    )
    if error:
        return web.json_response({"error": error}, status=status)
    return web.json_response({"ref": ref})


def _prepare_mesh_response(ref, session_id):
    """Resolve and lease a GET outside aiohttp's event loop."""
    base = _mesh_store_dir()
    path = os.path.join(base, f"{ref}.json") if base else None
    with _STORE_LOCK:
        if not path or not os.path.isfile(path):
            return None, "mesh not found", 404
        previous = _set_session_ref(session_id, ref)
        if not _stored_ref_matches(path, ref):
            if session_id:
                _restore_session_ref(session_id, previous, ref)
            else:
                _LEGACY_REF_LAST_SEEN.pop(ref, None)
            logging.error("Sculpt: stored mesh failed content-hash verification: %s", ref)
            return None, "stored mesh is corrupt", 409
        try:
            os.utime(path)
        except OSError:
            pass
    return path, None, 200


async def sculpt_load_mesh(request):
    ref = request.match_info.get("ref", "")
    if not MESH_REF_RE.fullmatch(ref):
        return web.json_response({"error": "invalid mesh reference"}, status=400)
    path, error, status = await asyncio.to_thread(
        _prepare_mesh_response, ref, _request_session_id(request)
    )
    if error:
        return web.json_response({"error": error}, status=status)
    return web.FileResponse(path, headers={"Content-Type": "application/json"})


def _prune_texture_store(base, keep_ref):
    """Drop least-recently-used atlases beyond the quotas, never the one just written."""
    try:
        entries = []
        for name in os.listdir(base):
            if not name.endswith(".png"):
                continue
            path = os.path.join(base, name)
            entries.append((os.path.getmtime(path), os.path.getsize(path), name[:-4], path))
        entries.sort()
        count = len(entries)
        total = sum(e[1] for e in entries)
        for _mtime, size, ref, path in entries:
            if count <= MAX_STORED_TEXTURES and total <= MAX_STORED_TEXTURE_BYTES:
                break
            if ref == keep_ref:
                continue
            os.remove(path)
            count -= 1
            total -= size
    except OSError:
        logging.warning("Sculpt: texture store pruning failed", exc_info=True)


def _validate_and_store_texture(raw):
    """Validate a PNG body and persist it content-addressed, outside the event loop."""
    if _validate_png_bytes(raw) is None:
        return None, "body must be a PNG image within the size and pixel limits", 400
    base = _texture_store_dir(create=True)
    if base is None:
        return None, "texture store unavailable", 500
    ref = hashlib.sha256(raw).hexdigest()
    path = os.path.join(base, f"{ref}.png")
    with _STORE_LOCK:
        _cleanup_abandoned_temp_files(base)
        if not os.path.exists(path) or not _stored_ref_matches(path, ref):
            tmp = f"{path}.{os.urandom(6).hex()}.tmp"
            try:
                with open(tmp, "wb") as file:
                    file.write(raw)
                    file.flush()
                    os.fsync(file.fileno())
                os.replace(tmp, path)
            except OSError:
                logging.error("Sculpt: failed to persist texture", exc_info=True)
                try:
                    os.remove(tmp)
                except OSError:
                    pass
                return None, "failed to persist texture", 500
        else:
            try:
                os.utime(path)
            except OSError:
                pass
        _prune_texture_store(base, ref)
    return ref, None, 200


async def sculpt_save_texture(request):
    if not request.content_type.startswith("image/png"):
        return web.json_response({"error": "Content-Type must be image/png"}, status=415)
    if request.content_length is not None and request.content_length > MAX_TEXTURE_BYTES:
        return web.json_response({"error": "texture too large"}, status=413)
    chunks = []
    total = 0
    async for chunk in request.content.iter_chunked(1024 * 1024):
        total += len(chunk)
        if total > MAX_TEXTURE_BYTES:
            return web.json_response({"error": "texture too large"}, status=413)
        chunks.append(chunk)
    raw = b"".join(chunks)
    ref, error, status = await asyncio.to_thread(_validate_and_store_texture, raw)
    if error:
        return web.json_response({"error": error}, status=status)
    return web.json_response({"ref": ref})


def _release_session(session_id):
    with _STORE_LOCK:
        _SESSION_SLOTS.pop(session_id, None)
        _SESSION_LAST_SEEN.pop(session_id, None)


async def sculpt_release_session(request):
    session_id = request.match_info.get("session_id", "")
    if not _SESSION_ID_RE.fullmatch(session_id):
        return web.json_response({"error": "invalid sculpt session"}, status=400)
    await asyncio.to_thread(_release_session, session_id)
    return web.Response(status=204)


def _stored_ref_matches(path, ref):
    """Bounded streaming verification for content-addressed GET responses.

    Legacy refs are truncated digests, so the stored digest is compared as a
    prefix, which still detects a file whose contents no longer match its ref.
    """
    try:
        if os.path.getsize(path) > MAX_SCULPT_DATA_BYTES:
            return False
        digest = hashlib.sha256()
        with open(path, "rb") as file:
            for chunk in iter(lambda: file.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest().startswith(ref)
    except OSError:
        return False


def _register_routes():
    """Idempotent route registration.

    Hot-reload helpers (e.g. ComfyUI-HotReloadHack) re-import custom node
    modules; registering the same paths twice into PromptServer's RouteTableDef
    makes aiohttp's add_routes() fail at startup with a HEAD-route conflict.
    A flag on the (persistent) PromptServer instance makes reimports no-ops.
    """
    instance = PromptServer.instance
    if getattr(instance, "_sculpt_routes_registered", False):
        return
    routes = instance.routes
    routes.post("/sculpt/mesh")(sculpt_save_mesh)
    routes.get("/sculpt/mesh/{ref}")(sculpt_load_mesh)
    routes.delete("/sculpt/session/{session_id}")(sculpt_release_session)
    routes.post("/sculpt/texture")(sculpt_save_texture)
    instance._sculpt_routes_registered = True


_register_routes()
