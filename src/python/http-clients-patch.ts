/**
 * Keeps urllib3 (so requests) and httpx on the VM's sockets (engine ADR 0029, N-3). On Emscripten both switch to the
 * browser's fetch when they are imported: urllib3 2 imports `urllib3.contrib.emscripten` and injects its fetch
 * connections, and httpx 0.28 imports `httpx._transports.jsfetch` as its default transport. In a module the browser's
 * network does not exist and a command cannot import `js`, so this finder answers those two modules with ones that keep
 * the libraries on their ordinary path: urllib3's injection does nothing, so it uses http.client over `socket` and `ssl`,
 * and httpx's fetch transports are its httpcore transports. The finder goes first on `sys.meta_path` and claims only
 * those two names.
 */
export const HTTP_CLIENTS_PATCH_SOURCE = `import importlib.abc as _abc
import importlib.util as _util
import sys as _sys

_REPLACEMENTS = {
    "urllib3.contrib.emscripten": '''"""urllib3's browser-fetch connections, left out: in an OxideVM module urllib3 uses the VM's sockets."""


def inject_into_urllib3():
    """Nothing to inject: urllib3 keeps its own connections over socket and ssl."""
''',
    "httpx._transports.jsfetch": '''"""httpx's browser-fetch transports, as its httpcore transports: in an OxideVM module httpx uses the VM's sockets."""

from .httpcore import AsyncHTTPCoreTransport as AsyncJavascriptFetchTransport
from .httpcore import HTTPCoreTransport as JavascriptFetchTransport

__all__ = ["AsyncJavascriptFetchTransport", "JavascriptFetchTransport"]
''',
}


class _SourceLoader(_abc.Loader):
    def __init__(self, source):
        self._source = source

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        exec(compile(self._source, "<oxidevm " + module.__name__ + ">", "exec"), module.__dict__)


class _SocketHttpClients(_abc.MetaPathFinder):
    """Answers the modules that would move urllib3 and httpx to the browser's fetch."""

    def find_spec(self, name, path=None, target=None):
        source = _REPLACEMENTS.get(name)
        if source is None:
            return None
        return _util.spec_from_loader(name, _SourceLoader(source), is_package=False)


_sys.meta_path.insert(0, _SocketHttpClients())
`;
