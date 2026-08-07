"""Pytest helpers: load the integration's pure modules without importing HA.

We build a fake `visit_heatmap` package in sys.modules that points at the
integration directory but never loads `__init__.py`, so the HA-dependent
code stays out of the unit tests.
"""

import importlib.util
import sys
import types
from datetime import UTC, datetime
from pathlib import Path

import pytest

_BASE = Path(__file__).parents[1]

_pkg = types.ModuleType("visit_heatmap")
_pkg.__path__ = [str(_BASE)]
sys.modules["visit_heatmap"] = _pkg


def _mod(name: str, **attrs) -> types.ModuleType:
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    return module


async def _noop(*_args, **_kwargs) -> None:
    pass


def _ws_command(schema):
    return lambda fn: fn


def _sync_decorator(fn):
    return fn


class _Marker:
    def __init__(self, key, **kwargs):
        self.key = key


_websocket_api = _mod(
    "homeassistant.components.websocket_api",
    ActiveConnection=object,
    websocket_command=_ws_command,
    require_admin=_sync_decorator,
    async_response=_sync_decorator,
    async_register_command=lambda hass, fn: None,
)
sys.modules["voluptuous"] = _mod(
    "voluptuous", Required=_Marker, Optional=_Marker
)
_util_dt = _mod(
    "homeassistant.util.dt",
    utcnow=lambda: datetime.now(UTC),
)
sys.modules["homeassistant"] = _mod("homeassistant")
sys.modules["homeassistant.const"] = _mod(
    "homeassistant.const", EVENT_STATE_CHANGED="state_changed"
)
sys.modules["homeassistant.core"] = _mod("homeassistant.core", HomeAssistant=object)
sys.modules["homeassistant.helpers"] = _mod("homeassistant.helpers")
sys.modules["homeassistant.helpers.typing"] = _mod(
    "homeassistant.helpers.typing", ConfigType=dict
)
sys.modules["homeassistant.util"] = _mod("homeassistant.util", dt=_util_dt)
sys.modules["homeassistant.util.dt"] = _util_dt
sys.modules["homeassistant.components"] = _mod("homeassistant.components")
sys.modules["homeassistant.components.frontend"] = _mod(
    "homeassistant.components.frontend",
    add_extra_js_url=lambda *a, **k: None,
    async_add_extra_js_url=_noop,
)
sys.modules["homeassistant.components.websocket_api"] = _websocket_api


def _load(name: str) -> types.ModuleType:
    if f"visit_heatmap.{name}" in sys.modules:
        return sys.modules[f"visit_heatmap.{name}"]
    spec = importlib.util.spec_from_file_location(
        f"visit_heatmap.{name}", _BASE / f"{name}.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[f"visit_heatmap.{name}"] = module
    spec.loader.exec_module(module)
    return module


_logic = _load("logic")
_const = _load("const")
_store = _load("store")
_init = _load("__init__")


@pytest.fixture
def logic():
    return _logic


@pytest.fixture
def store():
    return _store


@pytest.fixture
def runtime():
    return _init.VisitHeatmapRuntime
