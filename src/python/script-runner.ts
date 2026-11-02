import { REPL_SOURCE } from "./repl-runner.ts";

/**
 * Runs the user's program the way `python3 FILE`, `python3 -c CODE`, `python3 -m MODULE` and `python3 -` do, with top-level `await` allowed (and
 * `run_sync` usable, because it is started by `runPythonAsync`), and answers with the exit status it asks for. It runs in
 * a namespace of its own that holds `_request`, a dict with the program's `filename` (its absolute path, `<string>` or
 * `<stdin>`), its `source`, `argv`, `orig_argv`, `executable`, `path0` (for `sys.path[0]`), `file` (for `__file__`, or None)
 * and `cache_source` (whether tracebacks may show the source, as CPython 3.13+ does for -c). Errors are printed as Python
 * prints them, without this runner's own frames, the frames of this module's replacements of built-ins (which run as
 * `<exec>`) or the frames of Pyodide's JavaScript, so that the output looks like the program's under CPython, where a
 * built-in such as `time.sleep` shows no frame of its own. A KeyboardInterrupt the
 * program leaves unhandled is printed the same way and answered with "SIGINT", after atexit has run, so that the process
 * can end killed by SIGINT as CPython's does. `_request["arm"]` (or None) makes Pyodide watch for Ctrl+C; the runner calls
 * it inside its own `try`, so that no KeyboardInterrupt, not even one that arrived before the program started or while
 * the runner finishes, escapes into Pyodide's event loop. `eval_code_async` comes
 * from Pyodide's private `_pyodide._base`, because a program started as a command cannot import `pyodide.code`.
 *
 * `_request["run"]` says what runs: "source" (the text above), "module" (`-m`: runpy finds `_request["module"]` and runs
 * it as `__main__`; its frames appear as CPython's frozen runpy's, `<frozen runpy>` without source lines) or "none". With
 * `_request["interactive"]` the basic interactive interpreter (src/python/repl-runner.ts) runs afterwards in the program's
 * namespace, and, as with CPython's `-i`, an error or SystemExit of the program is printed as a traceback instead of
 * ending the process.
 */
export const SCRIPT_RUNNER_SOURCE = `import atexit as _atexit
import linecache as _linecache
import sys as _sys
import traceback as _traceback
import types as _types

from _pyodide._base import eval_code_async as _eval_code_async

_FROZEN_RUNPY = "<frozen runpy>"
_added_prompts = []


def _shown(filename):
    """Whether a frame is the program's or a Python module's: not a replacement of a built-in, not JavaScript."""
    if filename == "<exec>":
        return False
    return not ("://" in filename or filename.startswith("node:") or filename.endswith((".js", ".mjs", ".cjs", ".ts")))


def _is_runpy(filename):
    return filename == _FROZEN_RUNPY or filename.endswith("/runpy.py")


def _program_starts(filename):
    """The first frame of the program: its own file, or for -m the frame of runpy that runs the module."""
    if _request["run"] == "module":
        return _is_runpy(filename)
    return filename == _request["filename"]


def _user_traceback(error, starts):
    entry = error.__traceback__
    while entry is not None and not starts(entry.tb_frame.f_code.co_filename):
        entry = entry.tb_next
    kept = []
    while entry is not None:
        if _shown(entry.tb_frame.f_code.co_filename):
            kept.append(entry)
        entry = entry.tb_next
    shown = None
    for item in reversed(kept):
        shown = _types.TracebackType(shown, item.tb_frame, item.tb_lasti, item.tb_lineno)
    return shown


def _colorize():
    try:
        import _colorize

        return _colorize.can_colorize(file=_sys.stderr)
    except Exception:
        return False


def _print_error(error, starts):
    """Prints an error as CPython would, from the program's first frame on; runpy's frames look frozen, as in CPython."""
    report = _traceback.TracebackException(type(error), error, _user_traceback(error, starts), compact=True)
    for index, frame in enumerate(report.stack):
        if _is_runpy(frame.filename) and frame.filename != _FROZEN_RUNPY:
            report.stack[index] = _traceback.FrameSummary(_FROZEN_RUNPY, frame.lineno, frame.name, lookup_line=False)
    report.print(file=_sys.stderr, colorize=_colorize())


def _requested_status(code):
    if code is None:
        return 0
    if isinstance(code, int):
        return int(code)
    # SystemExit with any other object prints it and fails, as in the interpreter.
    print(code, file=_sys.stderr)
    return 1


def _started(program):
    """Gives the program what CPython gives a program it starts, and returns what to put back afterwards."""
    saved = (_sys.modules.get("__main__"), list(_sys.path))
    if _request["file"] is not None:
        program.__file__ = _request["file"]
    _sys.argv = list(_request["argv"])
    _sys.orig_argv = list(_request["orig_argv"])
    _sys.executable = _request["executable"]
    # Pyodide starts with "" (its working directory) first on sys.path; CPython puts the program's place there instead.
    if _sys.path and _sys.path[0] == "":
        _sys.path[0] = _request["path0"]
    else:
        _sys.path.insert(0, _request["path0"])
    if _request["cache_source"]:
        _linecache.cache[_request["filename"]] = (len(_request["source"]), None, _request["source"].splitlines(True), _request["filename"])
    _sys.modules["__main__"] = program
    return saved


def _finish(saved):
    original_main, original_path = saved
    if original_main is None:
        _sys.modules.pop("__main__", None)
    else:
        _sys.modules["__main__"] = original_main
    _atexit._run_exitfuncs()
    for stream in (_sys.stdout, _sys.stderr):
        try:
            stream.flush()
        except (OSError, ValueError):
            # ValueError: the program closed the stream, as python -m json.tool closes standard output.
            pass
    if _request["cache_source"]:
        _linecache.cache.pop(_request["filename"], None)
    for name in _added_prompts:
        if hasattr(_sys, name):
            delattr(_sys, name)
    _sys.path[:] = original_path


def _runpy_exit_text(stop):
    """The text of runpy's own "No module named ..." exit, named after argv[0] when there is no executable to name."""
    entry = stop.__traceback__
    while entry is not None and entry.tb_next is not None:
        entry = entry.tb_next
    raised_by_runpy = entry is not None and _is_runpy(entry.tb_frame.f_code.co_filename) and entry.tb_frame.f_code.co_name == "_run_module_as_main"
    if raised_by_runpy and _request["executable"] == "" and isinstance(stop.code, str) and stop.code.startswith(": "):
        return _request["argv0"] + stop.code
    return None


async def _execute(program):
    if _request["run"] == "module":
        import runpy as _runpy

        _runpy._run_module_as_main(_request["module"], True)
    elif _request["run"] == "source":
        await _eval_code_async(_request["source"], program.__dict__, filename=_request["filename"], return_mode="none", dont_inherit=True)


async def _program(program):
    """Runs the program; returns its status, or "SIGINT". With -i its errors are printed and the status is 0."""
    inspect = _request["interactive"]
    try:
        await _execute(program)
        return 0
    except SystemExit as stop:
        text = _runpy_exit_text(stop)
        if text is not None:
            print(text, file=_sys.stderr)
            return 1
        if not inspect:
            return _requested_status(stop.code)
        _print_error(stop, _program_starts)
        return 0
    except KeyboardInterrupt as error:
        _print_error(error, _program_starts)
        return "SIGINT"
    except BaseException as error:
        _print_error(error, _program_starts)
        return 0 if inspect else 1
${REPL_SOURCE}

async def _run():
    try:
        if _request["arm"] is not None:
            _request["arm"]()
        program = _types.ModuleType("__main__")
        saved = _started(program)
        try:
            status = await _program(program)
            if _request["interactive"]:
                return _repl(program, status == "SIGINT")
            return status
        finally:
            _finish(saved)
    except KeyboardInterrupt:
        # Ctrl+C before the program started, or while the runner finishes: the process ends by SIGINT all the same.
        return "SIGINT"


await _run()
`;
