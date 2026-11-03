"""Records how CPython itself treats the command lines that the module's python3 and python commands accept or refuse.

The module parses its command line the way CPython 3.14 does. test/cli.test.ts and test/command.test.ts compare it with
what this script records from a real CPython, so the expectations come from the interpreter and not from memory.

    python3.14 -I scripts/record-cpython-cli.py             writes test/fixtures/cpython-cli.json
    python3.14 -I scripts/record-cpython-cli.py --check     fails when the recording differs from that file

Every case runs in /tmp/oxidevm-pyodide-cli, which must not exist beforehand and is removed afterwards. The fixtures name
paths under it, and the tests recreate the same files at the same paths in the VM's /tmp, which the module can see. The
interpreter is started as "python3" found through PATH (a symbolic link in that directory), the way a shell in the VM
starts the module's command, with a small fixed environment and a standard input that is a pipe, never a terminal.
"""

import argparse
import datetime
import fcntl
import json
import os
import select
import shutil
import signal
import subprocess
import sys
import termios
import time

ROOT = "/tmp/oxidevm-pyodide-cli"
ARGV0 = "python3"
FIXTURE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "test", "fixtures", "cpython-cli.json")

# One line of Python that reports what a program sees of how it was started. It runs as a file, with -c and from
# standard input, so that every way of starting a program is compared on the same fields.
PROBE = (
    "import json, sys; print(json.dumps({"
    '"argv": sys.argv, "orig_argv": sys.orig_argv, "executable": sys.executable, "path0": sys.path[0], '
    '"file": globals().get("__file__"), "filename": sys._getframe(0).f_code.co_filename, "name": __name__'
    "}, sort_keys=True))"
)
FAILING = "def fail():\n    raise ValueError('bad value')\nfail()"
INTERRUPTED = "import atexit; atexit.register(print, 'atexit ran'); raise KeyboardInterrupt"
# time.sleep's checks of its argument, which the module's interruptible time.sleep repeats.
SLEEP_ARGUMENTS = """import decimal, fractions, time
class Index:
    def __index__(self):
        return 0
cases = [("-1", -1), ("nan", float("nan")), ("str", "1"), ("None", None), ("Decimal", decimal.Decimal("0.001")),
         ("Fraction", fractions.Fraction(1, 1000)), ("2**70", 2**70), ("inf", float("inf")), ("-inf", float("-inf")),
         ("True", True), ("0", 0), ("0.001", 0.001), ("__index__", Index())]
for label, value in cases:
    try:
        time.sleep(value)
        print(label, "slept")
    except Exception as error:
        print(label, type(error).__name__, error)"""

# The files the cases run, relative to ROOT. modprobe and pkgprobe are found by -m through the working directory, which
# CPython puts first on sys.path for -m.
FILES = {
    "sub/probe.py": PROBE + "\n",
    "-dash.py": PROBE + "\n",
    "modprobe.py": PROBE + "\n",
    "modfail.py": FAILING + "\n",
    "pkgprobe/__init__.py": "",
    "pkgprobe/__main__.py": PROBE + "\n",
    "pkgprobe/inner.py": PROBE + "\n",
}

# (name, arguments after argv[0], standard input, which part of standard output to keep)
CASES = [
    ("file-with-arguments", ["sub/probe.py", "one", "two words"], "", "all"),
    ("file-relative-with-dots", ["./sub/../sub/probe.py"], "", "all"),
    ("code-with-arguments", ["-c", PROBE, "one", "--two"], "", "all"),
    ("code-attached-to-option", ["-c" + PROBE, "one"], "", "all"),
    ("stdin-dash-with-arguments", ["-", "one", "two"], PROBE + "\n", "all"),
    ("stdin-without-arguments", [], PROBE + "\n", "all"),
    ("stdin-after-double-dash", ["--"], PROBE + "\n", "all"),
    ("version-short", ["-V"], "", "all"),
    ("version-long", ["--version"], "", "all"),
    ("version-before-code", ["-V", "-c", "print(1)"], "", "all"),
    ("version-then-unknown-option", ["-V", "-Z"], "", "all"),
    ("help-short", ["-h"], "", "first-line"),
    ("help-long", ["--help"], "", "first-line"),
    ("help-before-unknown-option", ["-h", "-Z"], "", "first-line"),
    ("unknown-option", ["-Z"], "", "all"),
    ("unknown-option-in-group", ["-uZ"], "", "all"),
    ("unknown-long-option", ["--foo"], "", "all"),
    ("long-option-in-group", ["-u-x"], "", "all"),
    ("empty-long-option-in-group", ["-u-", "sub/probe.py"], "", "all"),
    ("empty-long-option-ends-options", ["-u-", "-Z"], "", "all"),
    ("code-without-argument", ["-c"], "", "all"),
    ("grouped-code-without-argument", ["-uc"], "", "all"),
    ("double-dash-before-file", ["--", "sub/probe.py", "-c", "-Z"], "", "all"),
    ("options-after-file-are-arguments", ["sub/probe.py", "-c", "-Z"], "", "all"),
    ("grouped-flags-with-code", ["-uc", PROBE, "one"], "", "all"),
    ("ignored-flags", ["-u", "-B", "-E", "-s", "-q", "-c", PROBE], "", "all"),
    ("file-name-starting-with-dash", ["--", "-dash.py", "one"], "", "all"),
    ("missing-file", ["missing.py"], "", "all"),
    ("code-traceback", ["-c", FAILING], "", "all"),
    ("stdin-traceback", [], FAILING + "\n", "all"),
    ("system-exit-wraps", ["-c", "raise SystemExit(300)"], "", "all"),
    ("keyboard-interrupt", ["-c", INTERRUPTED], "", "all"),
    ("sleep-arguments", ["-c", SLEEP_ARGUMENTS], "", "all"),
    ("module-with-arguments", ["-m", "modprobe", "one", "--two"], "", "all"),
    ("module-attached-to-option", ["-mmodprobe", "one"], "", "all"),
    ("module-in-group", ["-um", "modprobe"], "", "all"),
    ("module-package-main", ["-m", "pkgprobe", "one"], "", "all"),
    ("module-submodule", ["-m", "pkgprobe.inner"], "", "all"),
    ("module-missing", ["-m", "nosuchmodule", "one"], "", "all"),
    ("module-without-argument", ["-m"], "", "all"),
    ("module-package-without-main", ["-m", "json.tool.nothing"], "", "all"),
    ("module-traceback", ["-m", "modfail"], "", "all"),
    ("module-after-code", ["-c", "print('code')", "-m", "modprobe"], "", "all"),
    ("code-after-module", ["-m", "modprobe", "-c", "print('code')"], "", "all"),
    ("module-stdlib", ["-m", "base64", "-e"], "hello\n", "all"),
    ("interactive-code-pipe", ["-i", "-c", "x = 5"], "print(x * 2)\n", "all"),
    ("interactive-stdin-pipe", ["-i"], "x = 7\nprint(x)\n", "all"),
]

# Sessions at a terminal: standard input is a pseudo-terminal (cooked mode, as the VM's PTY), standard output and
# standard error are pipes, recorded apart. CPython's basic REPL is chosen with PYTHON_BASIC_REPL=1 and readline is made
# unimportable, so the REPL reads lines as CPython does without readline: prompts on standard error, no history, no
# completion. Each step is sent once the REPL has written a prompt (">>> " or "... " ends standard error), or, for a
# step marked "running", a moment after the previous one, to interrupt a program that is still running.
PROMPT = "prompt"
RUNNING = "running"
SESSIONS = [
    ("repl-expressions", [], [("1 + 1\n", PROMPT), ("x = 'text'\n", PROMPT), ("x\n", PROMPT), ("print(x)\n", PROMPT), ("None\n", PROMPT), ("\x04", PROMPT)]),
    ("repl-quiet", ["-q"], [("6 * 7\n", PROMPT), ("\x04", PROMPT)]),
    ("repl-block", ["-q"], [("for i in range(2):\n", PROMPT), ("    print(i)\n", PROMPT), ("\n", PROMPT), ("def f(a):\n", PROMPT), ("    return a + 1\n", PROMPT), ("\n", PROMPT), ("f(1)\n", PROMPT), ("\x04", PROMPT)]),
    ("repl-exception", ["-q"], [("1 / 0\n", PROMPT), ("undefined_name\n", PROMPT), ("def f(:\n", PROMPT), ("'still here'\n", PROMPT), ("\x04", PROMPT)]),
    ("repl-interrupt-at-prompt", ["-q"], [("\x03", PROMPT), ("for i in range(2):\n", PROMPT), ("\x03", PROMPT), ("'after'\n", PROMPT), ("\x04", PROMPT)]),
    ("repl-interrupt-loop", ["-q"], [("while True: pass\n", PROMPT), ("\n", PROMPT), ("\x03", RUNNING), ("'after'\n", PROMPT), ("\x04", PROMPT)]),
    ("repl-interrupt-then-exit", ["-q"], [("\x03", PROMPT), ("import sys; sys.exit(2)\n", PROMPT)]),
    ("repl-handled-interrupt", ["-q"], [("try:\n", PROMPT), ("    raise KeyboardInterrupt\n", PROMPT), ("except KeyboardInterrupt:\n", PROMPT), ("    print('handled')\n", PROMPT), ("\n", PROMPT), ("\x04", PROMPT)]),
    ("repl-earlier-function-raises", ["-q"], [("def g():\n", PROMPT), ("    return 1 / 0\n", PROMPT), ("\n", PROMPT), ("x = 1\n", PROMPT), ("g()\n", PROMPT), ("\x04", PROMPT)]),
    ("repl-exit-status", ["-q"], [("import sys; sys.exit(3)\n", PROMPT)]),
    ("repl-exit-builtin", ["-q"], [("exit(4)\n", PROMPT)]),
    ("repl-uncaught-system-exit-text", ["-q"], [("raise SystemExit('bye')\n", PROMPT)]),
    ("repl-dash", ["-q", "-"], [("'dash'\n", PROMPT), ("\x04", PROMPT)]),
    ("repl-argv", ["-q", "-", "one"], [("import sys; sys.argv, sys.path[0]\n", PROMPT), ("\x04", PROMPT)]),
    ("interactive-after-code", ["-q", "-i", "-c", "x = 5"], [("x * 2\n", PROMPT), ("\x04", PROMPT)]),
    ("interactive-after-code-banner", ["-i", "-c", "print('ran')"], [("\x04", PROMPT)]),
    ("interactive-after-raising-code", ["-q", "-i", "-c", "def f():\n    raise ValueError('bad')\nf()"], [("'alive'\n", PROMPT), ("\x04", PROMPT)]),
    ("interactive-after-raising-file", ["-q", "-i", "modfail.py"], [("\x04", PROMPT)]),
    ("interactive-after-exit", ["-q", "-i", "-c", "import sys; sys.exit(5)"], [("'inspect'\n", PROMPT), ("\x04", PROMPT)]),
    ("interactive-after-module", ["-q", "-i", "-m", "modprobe"], [("__name__\n", PROMPT), ("\x04", PROMPT)]),
    ("interactive-after-interrupt", ["-q", "-i", "-c", "raise KeyboardInterrupt"], [("\x04", PROMPT)]),
]


def environment():
    """What the interpreter starts with: python3 on PATH, UTF-8 text, and no PYTHON* variables."""
    return {"PATH": os.path.join(ROOT, "bin"), "HOME": ROOT, "LC_ALL": "C.UTF-8"}


# Where the sessions find a readline that cannot be imported, so that CPython reads lines without it.
NO_READLINE = os.path.join(ROOT, "no-readline")


def session_environment():
    """The environment of a terminal session: the basic REPL, and readline out of reach."""
    return {**environment(), "PYTHON_BASIC_REPL": "1", "PYTHONPATH": NO_READLINE, "TERM": "dumb"}


def exit_of(returncode):
    if returncode < 0:
        return {"kind": "signaled", "signal": signal.Signals(-returncode).name}
    return {"kind": "exited", "code": returncode}


def kept(text, part):
    if part == "first-line":
        return text.split("\n", 1)[0] + "\n" if text else ""
    return text


def prepare(interpreter):
    if os.path.lexists(ROOT):
        sys.exit(f"{ROOT} exists; remove it first (the fixtures name paths under it)")
    os.makedirs(os.path.join(ROOT, "bin"))
    os.symlink(interpreter, os.path.join(ROOT, "bin", ARGV0))
    for name, text in FILES.items():
        path = os.path.join(ROOT, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as file:
            file.write(text)
    os.makedirs(NO_READLINE)
    with open(os.path.join(NO_READLINE, "readline.py"), "w", encoding="utf-8") as file:
        file.write("raise ImportError('readline is left out of this recording')\n")


def run_session(arguments, steps):
    """Runs one terminal session and returns its standard output, standard error and exit."""
    leader, follower = os.openpty()
    attrs = termios.tcgetattr(follower)
    attrs[3] &= ~termios.ECHO  # the VM's terminal echoes; the recording keeps only what Python writes
    termios.tcsetattr(follower, termios.TCSANOW, attrs)

    def controlling_terminal():
        os.setsid()
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)

    process = subprocess.Popen([ARGV0, *arguments], executable=os.path.join(ROOT, "bin", ARGV0), cwd=ROOT, env=session_environment(),
                               stdin=follower, stdout=subprocess.PIPE, stderr=subprocess.PIPE, preexec_fn=controlling_terminal)
    os.close(follower)
    out, err = bytearray(), bytearray()
    streams = {process.stdout.fileno(): out, process.stderr.fileno(): err}

    def pump(seconds):
        """Reads what is ready for up to `seconds`; returns False once both pipes have ended."""
        ready, _, _ = select.select([*streams, leader], [], [], seconds)
        for fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b""
            if fd == leader:
                continue
            if not data:
                del streams[fd]
            else:
                streams[fd].extend(data)
        return bool(streams)

    def wait_for_prompt():
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if err.endswith(b">>> ") or err.endswith(b"... "):
                return
            if not pump(0.1):
                return
        sys.exit(f"no prompt from {arguments}: {bytes(err)!r}")

    for text, when in steps:
        if when == PROMPT:
            wait_for_prompt()
        else:
            deadline = time.monotonic() + 0.5
            while time.monotonic() < deadline:
                pump(0.05)
        if process.poll() is not None:
            break
        mark = len(err)
        os.write(leader, text.encode())
        # The prompt that was just answered is not the next one: wait until standard error moves on, or briefly when the
        # input starts a program that keeps running.
        deadline = time.monotonic() + 5
        while len(err) == mark and time.monotonic() < deadline and pump(0.1) and process.poll() is None:
            pass
    deadline = time.monotonic() + 30
    while streams and time.monotonic() < deadline:
        pump(0.1)
    returncode = process.wait(timeout=30)
    os.close(leader)
    return out.decode(), err.decode(), exit_of(returncode)


def describe(interpreter):
    """The interpreter's version, from the interpreter itself."""
    result = subprocess.run([interpreter, "-I", "-c", "import platform, sys; print(platform.python_version()); print(sys.version)"],
                            capture_output=True, text=True, check=True, timeout=60)
    version, build = result.stdout.splitlines()[:2]
    if not version.startswith("3.14."):
        sys.exit(f"{interpreter} is Python {version}; the module follows CPython 3.14")
    return version, build


def record(interpreter):
    version, build = describe(interpreter)
    prepare(interpreter)
    try:
        cases = []
        for name, arguments, stdin, part in CASES:
            result = subprocess.run([ARGV0, *arguments], executable=os.path.join(ROOT, "bin", ARGV0), cwd=ROOT, env=environment(),
                                    input=stdin.encode(), capture_output=True, timeout=120)
            cases.append({
                "name": name,
                "argv": [ARGV0, *arguments],
                "stdin": stdin,
                "stdout": kept(result.stdout.decode(), part),
                "stdoutKept": part,
                "stderr": result.stderr.decode(),
                "exit": exit_of(result.returncode),
            })
        sessions = []
        for name, arguments, steps in SESSIONS:
            stdout, stderr, ended = run_session(arguments, steps)
            sessions.append({
                "name": name,
                "argv": [ARGV0, *arguments],
                "steps": [{"input": text, "when": when} for text, when in steps],
                "stdout": stdout,
                "stderr": stderr,
                "exit": ended,
            })
    finally:
        shutil.rmtree(ROOT)
    return {
        "schemaVersion": 1,
        "provenance": {
            "interpreter": interpreter,
            "version": version,
            "build": build,
            "recorded": datetime.date.today().isoformat(),
            "recorder": "scripts/record-cpython-cli.py",
            "command": "python3.14 -I scripts/record-cpython-cli.py",
            "cwd": ROOT,
            "argv0": ARGV0,
            "executable": os.path.join(ROOT, "bin", ARGV0),
            "environment": environment(),
            "stdin": "a pipe (never a terminal); empty unless the case gives text",
        },
        "files": FILES,
        "cases": cases,
        "sessions": sessions,
        "sessionEnvironment": {**session_environment(), "PYTHONPATH": "(a directory whose readline.py raises ImportError)"},
    }


def main():
    parser = argparse.ArgumentParser(description="Record CPython's command-line behaviour for the module's tests.")
    parser.add_argument("--interpreter", default=os.path.realpath(sys.executable), help="the CPython 3.14 to record (default: this one)")
    parser.add_argument("--check", action="store_true", help="compare with the fixture instead of writing it (the date is not compared)")
    options = parser.parse_args()
    recorded = record(os.path.realpath(options.interpreter))
    if options.check:
        with open(FIXTURE, encoding="utf-8") as file:
            existing = json.load(file)
        existing["provenance"]["recorded"] = recorded["provenance"]["recorded"]
        if existing != recorded:
            sys.exit(f"{FIXTURE} differs from what {options.interpreter} does now; record it again")
        print(f"{FIXTURE} matches {options.interpreter}")
        return
    os.makedirs(os.path.dirname(FIXTURE), exist_ok=True)
    with open(FIXTURE, "w", encoding="utf-8") as file:
        json.dump(recorded, file, indent=2, ensure_ascii=False)
        file.write("\n")
    print(f"wrote {len(recorded['cases'])} cases to {FIXTURE}")


if __name__ == "__main__":
    main()
