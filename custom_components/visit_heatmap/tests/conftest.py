"""Pytest helpers: load the integration's pure modules without importing HA.

We build a fake `visit_heatmap` package in sys.modules that points at the
integration directory but never loads `__init__.py`, so the HA-dependent
code stays out of the unit tests.
"""

import importlib.util
import sys
import types
from pathlib import Path

import pytest

_BASE = Path(__file__).parents[1]

_pkg = types.ModuleType("visit_heatmap")
_pkg.__path__ = [str(_BASE)]
sys.modules["visit_heatmap"] = _pkg


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


@pytest.fixture
def logic():
    return _logic


@pytest.fixture
def store():
    return _store
