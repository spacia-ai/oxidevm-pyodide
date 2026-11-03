/**
 * Loads a shipped package when a program imports it: a finder that goes on `sys.meta_path` ahead of Pyodide's own hook
 * (which would only say how to install the package) and, for the top-level name of a package the release carries
 * (`_oxidevm_packages.imports`, from the lock's `imports`: `PIL` is pillow, `pylab` and `mpl_toolkits` are matplotlib),
 * installs it and what it needs from the release's verified copies, synchronously (`installSync` in
 * src/python-loader.ts), then lets the ordinary finders import it. It needs no WebAssembly JSPI and works wherever Python
 * imports, callbacks from JavaScript included. A Ctrl+C during the install is raised once it ends, like after any call
 * of the bridge.
 */
export const LAZY_PACKAGES_SOURCE = `import importlib as _importlib
import sys as _sys

import _oxidevm_bridge as _bridge
import _oxidevm_packages as _packages


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
        outcome = _bridge.load_packages(package)
        _bridge.check_interrupt()
        if not outcome.ok:
            raise ImportError("cannot load the " + package + " package for " + repr(name) + ": " + str(outcome.error), name=name)
        self._loaded.update(outcome.value)
        _importlib.invalidate_caches()
        return None


_sys.meta_path.insert(0, _ShippedPackages(_packages.imports.to_py(), _packages.loaded.to_py()))
`;
