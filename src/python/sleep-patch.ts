/**
 * Replaces `time.sleep` with one that Ctrl+C ends at once. Pyodide's own `time.sleep` waits on an asyncio timer: a Ctrl+C
 * during the wait is noticed only when the time is up, and then inside Pyodide's event loop, which cannot take a
 * KeyboardInterrupt (see src/signals.ts). This one waits in JavaScript through `_oxidevm_bridge.sleep`, which ends early
 * when a Ctrl+C is pending and holds it, and then raises it with `check_interrupt`. Its arguments are checked as CPython
 * 3.14's `time.sleep` checks them, with the same messages. Where Python cannot wait for JavaScript (`can_run_sync` is
 * false), Pyodide's own sleep is used.
 */
export const SLEEP_PATCH_SOURCE = `import operator as _operator
import time as _time
from functools import wraps as _wraps

import _oxidevm_bridge as _bridge
from pyodide.ffi import can_run_sync as _can_run_sync, run_sync as _run_sync

_pyodide_sleep = _time.sleep
# The longest time CPython can represent: 2**63 - 1 nanoseconds.
_LIMIT = 9223372036.854775807


def _type_name(value):
    kind = type(value)
    return kind.__qualname__ if kind.__module__ == "builtins" else kind.__module__ + "." + kind.__qualname__


def _seconds(value):
    if isinstance(value, float):
        if value != value:
            raise ValueError("Invalid value NaN (not a number)")
        if abs(value) > _LIMIT:
            raise OverflowError("timestamp out of range for platform time_t")
    else:
        try:
            value = _operator.index(value)
        except TypeError:
            raise TypeError("'" + _type_name(value) + "' object cannot be interpreted as an integer or float") from None
        if abs(value) > _LIMIT:
            raise OverflowError("timestamp too large to convert to C PyTime_t")
    if value < 0:
        raise ValueError("sleep length must be non-negative")
    return value


@_wraps(_pyodide_sleep)
def sleep(seconds):
    seconds = _seconds(seconds)
    if not _can_run_sync():
        return _pyodide_sleep(seconds)
    _run_sync(_bridge.sleep(seconds * 1000))
    _bridge.check_interrupt()


_time.sleep = sleep
`;
