/**
 * CPython's basic interactive interpreter (the REPL that `PYTHON_BASIC_REPL=1` selects in CPython 3.13+, without
 * readline), written in Python for the runner (src/python/script-runner.ts), whose names it uses. The terminal edits the
 * line (the VM's PTY in cooked mode); there is no history and no completion. As in CPython:
 * - the banner (`Python <version> on <platform>` and the line about help) and every prompt go to standard error, which is
 *   flushed before a line is read; `sys.ps1` and `sys.ps2` are the prompts, created when they are missing;
 * - each input is compiled as `<stdin>` in "single" mode, so an expression's value goes to `sys.displayhook`; a compound
 *   statement continues with `sys.ps2` until an empty line; the source is registered with linecache per code object, so
 *   a traceback shows the line of the input that defined the function, as CPython 3.13+ does;
 * - an error prints its traceback and the prompt returns; SystemExit ends the session with its status;
 * - Ctrl+C at a prompt prints `KeyboardInterrupt` on a line of its own and drops the unfinished input; Ctrl+C while an
 *   input runs prints its traceback;
 * - end of input (Ctrl+D at the start of a line) prints a newline and ends the session with status 0, or, once any
 *   KeyboardInterrupt has been reported in the session (also by the program before it), killed by SIGINT, which is what
 *   CPython 3.14's `Py_RunMain` does with its unhandled-interrupt flag.
 * `_repl(program, interrupted)` returns the status or "SIGINT".
 */
export const REPL_SOURCE = `
_REPL_COPYRIGHT = 'Type "help", "copyright", "credits" or "license" for more information.'


def _repl_compile(source):
    import codeop as _codeop

    return _codeop.compile_command(source, "<stdin>", "single")


def _repl_register(code, source):
    register = getattr(_linecache, "_register_code", None)
    if register is not None:
        register(code, source, "<stdin>")


def _repl_prompt(name, default):
    if not hasattr(_sys, name):
        setattr(_sys, name, default)
        _added_prompts.append(name)
    return str(getattr(_sys, name))


def _repl_read(prompt):
    for stream in (_sys.stdout, _sys.stderr):
        try:
            stream.flush()
        except (OSError, ValueError):
            pass
    _sys.stderr.write(prompt)
    _sys.stderr.flush()
    return _sys.stdin.readline()


def _repl_from_stdin(filename):
    return filename == "<stdin>"


def _repl(program, interrupted):
    if _request["banner"]:
        print(f"Python {_sys.version} on {_sys.platform}", file=_sys.stderr)
        print(_REPL_COPYRIGHT, file=_sys.stderr)
    namespace = program.__dict__
    lines = []
    while True:
        try:
            prompt = _repl_prompt("ps2", "... ") if lines else _repl_prompt("ps1", ">>> ")
            try:
                line = _repl_read(prompt)
            except KeyboardInterrupt:
                _sys.stderr.write("\\nKeyboardInterrupt\\n")
                lines = []
                interrupted = True
                continue
            if line == "":
                _sys.stderr.write("\\n")
                break
            # As code.InteractiveConsole does: lines without their newline, so that a compound statement stays
            # incomplete until an empty line ends it.
            lines.append(line[:-1] if line.endswith("\\n") else line)
            source = "\\n".join(lines)
            try:
                code = _repl_compile(source)
            except (SyntaxError, OverflowError, ValueError) as error:
                lines = []
                _print_error(error, _repl_from_stdin)
                continue
            if code is None:
                continue
            lines = []
            _repl_register(code, source)
            try:
                exec(code, namespace)
            except SystemExit as stop:
                return _requested_status(stop.code)
            except KeyboardInterrupt as error:
                _print_error(error, _repl_from_stdin)
                interrupted = True
            except BaseException as error:
                _print_error(error, _repl_from_stdin)
        except KeyboardInterrupt:
            # A Ctrl+C between two steps of the loop itself: the same as at the prompt.
            _sys.stderr.write("\\nKeyboardInterrupt\\n")
            lines = []
            interrupted = True
    return "SIGINT" if interrupted else 0
`;
