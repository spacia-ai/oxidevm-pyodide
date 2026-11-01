/** The modules a program started as a command cannot import (engine ADR 0027, an owner condition of that record). */
export const HIDDEN_MODULES = ["js", "pyodide_js", "pyodide.ffi", "pyodide.http", "pyodide.code"] as const;

/**
 * Hides Pyodide's JavaScript bridge from a program started as a command: `js`, `pyodide_js`, `pyodide.ffi`, `pyodide.http`
 * and `pyodide.code`, with their submodules, cannot be imported, and the `pyodide` package no longer offers the last
 * three as attributes. It is defence in depth, not a boundary: Pyodide's private modules and objects that the `oxidevm`
 * module holds still lead to JavaScript. What this module's own code needs is kept: `oxidevm` is imported here, while
 * its imports still work (it keeps `run_sync`, `to_js` and `JsException`), the runner and `time.sleep` took what they use
 * when they were set up, and `pyodide_js._api`, which Pyodide's `asyncio.run` and event loop import whenever they run,
 * stays loaded. The finder goes first on `sys.meta_path`, before Pyodide's own, which would create `js` again.
 */
export const HIDE_BRIDGE_SOURCE = `import sys as _sys

import oxidevm
import pyodide as _pyodide

_HIDDEN = ${JSON.stringify(HIDDEN_MODULES).replace(/^\[/u, "(").replace(/\]$/u, ")")}
_KEPT = ("pyodide_js._api",)


def _hidden(name):
    return any(name == root or name.startswith(root + ".") for root in _HIDDEN)


class _HiddenBridge:
    """Refuses to import the JavaScript bridge into a program run as a command."""

    @staticmethod
    def find_spec(name, path=None, target=None):
        if _hidden(name):
            raise ModuleNotFoundError("No module named " + repr(name) + " (a program run as a command cannot reach JavaScript)", name=name)
        return None

    @staticmethod
    def invalidate_caches():
        pass


for _name in [name for name in _sys.modules if _hidden(name) and name not in _KEPT]:
    del _sys.modules[_name]
for _attribute in ("ffi", "http", "code"):
    _pyodide.__dict__.pop(_attribute, None)
_sys.meta_path.insert(0, _HiddenBridge)
`;
