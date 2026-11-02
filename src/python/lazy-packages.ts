/**
 * Loads a shipped package when a program imports it: a finder that goes on `sys.meta_path` ahead of Pyodide's own hook
 * (which would only say how to install the package) and, for the top-level name of a package the release carries
 * (`_oxidevm_packages.imports`, from the lock's `imports`: `PIL` is pillow, `pylab` and `mpl_toolkits` are matplotlib),
 * loads it and what it needs from the release's verified copies, then lets the ordinary finders import it. The import
 * waits for the load as a system call waits (`run_sync`), so a Ctrl+C meanwhile is raised once it ends, like after any
 * wait of the bridge. Where Python cannot wait for JavaScript (`can_run_sync` is false), the import fails with a
 * ModuleNotFoundError that says to name the package in the module's `packages` option, which loads it before the program.
 */
export const LAZY_PACKAGES_SOURCE = `import importlib as _importlib
import sys as _sys

import _oxidevm_bridge as _bridge
import _oxidevm_packages as _packages
from pyodide.ffi import can_run_sync as _can_run_sync, run_sync as _run_sync


class _ShippedPackages:
    """Loads a package the module ships the first time a program imports one of its top-level modules."""

    def __init__(self, imports, loaded):
        self._imports = dict(imports)
        self._loaded = set(loaded)

    def find_spec(self, name, path=None, target=None):
        if path is not None or "." in name:
            return None
        package = self._imports.get(name)
        if package is None or package in self._loaded:
            return None
        if not _can_run_sync():
            raise ModuleNotFoundError(
                "No module named " + repr(name) + ": the " + package + " package loads on import only where Python can"
                + " wait; name it in the module's packages option to load it before the program starts",
                name=name,
            )
        outcome = _run_sync(_bridge.load_packages(package))
        _bridge.check_interrupt()
        if not outcome.ok:
            raise ImportError("cannot load the " + package + " package for " + repr(name) + ": " + str(outcome.error), name=name)
        self._loaded.update(outcome.value)
        _importlib.invalidate_caches()
        return None


_sys.meta_path.insert(0, _ShippedPackages(_packages.imports.to_py(), _packages.loaded.to_py()))
`;
