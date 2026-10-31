/**
 * Runs the user's program the way `python script.py` does, with top-level `await` allowed (and `run_sync` usable,
 * because it is started by `runPythonAsync`), and answers with the exit status it asks for. It runs in a namespace of
 * its own that holds `_request`, a dict with the program's absolute `path`, its `source` text and `argv` (the script as
 * typed, then its arguments). Errors are printed as Python prints them, without this runner's own frames, so that the
 * output looks like the program's.
 */
export const SCRIPT_RUNNER_SOURCE = `import atexit as _atexit
import os as _os
import sys as _sys
import traceback as _traceback
import types as _types

from pyodide.code import eval_code_async as _eval_code_async


def _user_traceback(error):
    entry = error.__traceback__
    while entry is not None and entry.tb_frame.f_code.co_filename != _request["path"]:
        entry = entry.tb_next
    return entry


def _requested_status(code):
    if code is None:
        return 0
    if isinstance(code, int):
        return int(code)
    # SystemExit with any other object prints it and fails, as in the interpreter.
    print(code, file=_sys.stderr)
    return 1


def _finish(original_main):
    if original_main is None:
        _sys.modules.pop("__main__", None)
    else:
        _sys.modules["__main__"] = original_main
    _atexit._run_exitfuncs()
    for stream in (_sys.stdout, _sys.stderr):
        try:
            stream.flush()
        except OSError:
            pass


async def _run():
    program = _types.ModuleType("__main__")
    program.__file__ = _request["path"]
    _sys.argv = list(_request["argv"])
    _sys.path.insert(0, _os.path.dirname(_request["path"]))
    original_main = _sys.modules.get("__main__")
    _sys.modules["__main__"] = program
    try:
        await _eval_code_async(_request["source"], program.__dict__, filename=_request["path"], return_mode="none", dont_inherit=True)
        return 0
    except SystemExit as stop:
        return _requested_status(stop.code)
    except BaseException as error:
        _traceback.print_exception(type(error), error, _user_traceback(error))
        return 1
    finally:
        _finish(original_main)


await _run()
`;
