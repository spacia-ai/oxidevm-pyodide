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
import json
import os
import shutil
import signal
import subprocess
import sys

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

# The files the cases run, relative to ROOT.
FILES = {"sub/probe.py": PROBE + "\n", "-dash.py": PROBE + "\n"}

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
]


def environment():
    """What the interpreter starts with: python3 on PATH, UTF-8 text, and no PYTHON* variables."""
    return {"PATH": os.path.join(ROOT, "bin"), "HOME": ROOT, "LC_ALL": "C.UTF-8"}


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
