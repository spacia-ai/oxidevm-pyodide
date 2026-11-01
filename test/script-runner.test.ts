import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PYTHON_VERSION } from "../src/cli.ts";
import { normalised, oracle, oracleFiles, recordedOutcome } from "./support/cpython-oracle.ts";
import { startGuest } from "./support/guest-fixture.ts";
import type { GuestFixture } from "./support/guest-fixture.ts";

// These tests run programs through the same runner `main` uses, in the real Pyodide, and look at the exit status and the
// text on standard output and standard error.

let guest: GuestFixture;
beforeAll(async () => {
  guest = await startGuest();
  for (const [path, text] of oracleFiles()) {
    await mkdir(dirname(guest.files.real(path)), { recursive: true });
    await writeFile(guest.files.real(path), text);
  }
});
afterAll(async () => { await guest.stop(); await guest.dispose(); });

describe("exit status", () => {
  it("is 0 for a program that finishes, and its output is delivered", async () => {
    expect(await guest.run('print("hello")\nprint("to stderr", file=__import__("sys").stderr)')).toEqual({ status: 0, stdout: "hello\n", stderr: "to stderr\n" });
  });

  it("is the number given to sys.exit, wrapped like an operating system status and limited to 119", async () => {
    const statuses: [string, number][] = [
      ["sys.exit(3)", 3], ["sys.exit()", 0], ["sys.exit(None)", 0], ["sys.exit(0)", 0], ["sys.exit(True)", 1], ["sys.exit(False)", 0],
      ["sys.exit(119)", 119], ["sys.exit(120)", 119], ["sys.exit(200)", 119], ["sys.exit(256)", 0], ["sys.exit(257)", 1], ["sys.exit(-1)", 119], ["sys.exit(2**70 + 5)", 5],
      ["raise SystemExit(7)", 7], ["raise SystemExit", 0],
    ];
    for (const [code, expected] of statuses) {
      const result = await guest.run(`import sys\n${code}`);
      expect(result.status, code).toBe(expected);
      expect(result.stderr, code).toBe("");
    }
  });

  it("is 1 with the message on standard error when sys.exit gets something that is not a number", async () => {
    expect(await guest.run('import sys\nsys.exit("something went wrong")')).toEqual({ status: 1, stdout: "", stderr: "something went wrong\n" });
    expect((await guest.run("import sys\nsys.exit([1, 2])")).stderr).toBe("[1, 2]\n");
  });

  it("still delivers the output printed before the program exits", async () => {
    expect(await guest.run('import sys\nprint("before")\nsys.exit(4)')).toMatchObject({ status: 4, stdout: "before\n" });
  });
});

describe("errors", () => {
  it("prints the traceback of the program only, as Python does, and exits with 1", async () => {
    const result = await guest.run('def inner():\n    raise ValueError("bad value")\n\ndef outer():\n    inner()\n\nouter()\n');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    const lines = result.stderr.trimEnd().split("\n");
    expect(lines[0]).toBe("Traceback (most recent call last):");
    expect(lines).toContain('  File "/workspace/program.py", line 7, in <module>');
    expect(lines).toContain('  File "/workspace/program.py", line 5, in outer');
    expect(lines).toContain('  File "/workspace/program.py", line 2, in inner');
    expect(lines).toContain('    raise ValueError("bad value")');
    expect(lines.at(-1)).toBe("ValueError: bad value");
    expect(result.stderr).not.toMatch(/_pyodide|eval_code_async|oxidevm-runner|_base\.py/u);
    // Frames appear from the program's outermost call to the failing line.
    expect(lines.findIndex(line => line.includes("line 7"))).toBeLessThan(lines.findIndex(line => line.includes("line 2")));
  });

  it("reports a syntax error with its place, without a traceback of the runner", async () => {
    const result = await guest.run("x = 1\nif True print(x)\n");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('File "/workspace/program.py", line 2');
    expect(result.stderr).toContain("SyntaxError");
    expect(result.stderr).not.toMatch(/_pyodide|eval_code_async/u);
  });

  it("prints a chained exception with its cause", async () => {
    const result = await guest.run('try:\n    {}["missing"]\nexcept KeyError as error:\n    raise RuntimeError("wrapped") from error\n');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("KeyError: 'missing'");
    expect(result.stderr).toContain("The above exception was the direct cause of the following exception:");
    expect(result.stderr.trimEnd().split("\n").at(-1)).toBe("RuntimeError: wrapped");
  });

  it("keeps the output printed before an error", async () => {
    expect(await guest.run('print("progress")\n1 / 0')).toMatchObject({ status: 1, stdout: "progress\n" });
  });

  it("treats a failed import like any other error", async () => {
    const result = await guest.run("import module_that_does_not_exist");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ModuleNotFoundError: No module named 'module_that_does_not_exist'");
  });

  it("leaves the interpreter usable for the next program", async () => {
    await guest.run("1 / 0");
    expect(await guest.run('print("still here")')).toEqual({ status: 0, stdout: "still here\n", stderr: "" });
  });
});

describe("the program's world", () => {
  it("sees its arguments, name and file like a script started with python", async () => {
    const result = await guest.run('import sys\nprint(sys.argv)\nprint(__name__, __file__)\nprint(sys.modules["__main__"].__file__)', { args: ["one", "--two", "три"] });
    expect(result).toEqual({ status: 0, stdout: "['/workspace/program.py', 'one', '--two', 'три']\n__main__ /workspace/program.py\n/workspace/program.py\n", stderr: "" });
  });

  it("is the __main__ module while it runs, so classes it defines can be pickled, and the previous one is back afterwards", async () => {
    const result = await guest.run("import pickle\nfrom dataclasses import dataclass\n\n@dataclass\nclass Point:\n    x: int = 1\n\nprint(pickle.loads(pickle.dumps(Point(5))))\n");
    expect(result).toEqual({ status: 0, stdout: "Point(x=5)\n", stderr: "" });
    expect(guest.py.runPython("import sys\ngetattr(sys.modules['__main__'], '__file__', None)")).toBeUndefined();
  });

  it("finds modules next to the script", async () => {
    await writeFile(join(guest.files.real("/workspace"), "sibling_module.py"), "VALUE = 'from the sibling'\n");
    expect(await guest.run("import sibling_module\nprint(sibling_module.VALUE)")).toEqual({ status: 0, stdout: "from the sibling\n", stderr: "" });
  });

  it("has the script's own directory first on sys.path, so that a module next to it wins over an installed one", async () => {
    const sibling = join(guest.files.real("/workspace"), "colorsys.py");
    await writeFile(sibling, "VALUE = 'the sibling, not the standard library'\n");
    try {
      expect(await guest.run("import sys, colorsys\nprint(sys.path[0])\nprint(colorsys.VALUE)")).toEqual({ status: 0, stdout: "/workspace\nthe sibling, not the standard library\n", stderr: "" });
    } finally {
      await rm(sibling);
    }
  });

  it("allows top-level await", async () => {
    expect(await guest.run('import asyncio\nawait asyncio.sleep(0)\nresult = await asyncio.sleep(0, "done")\nprint(result)')).toEqual({ status: 0, stdout: "done\n", stderr: "" });
  });

  it("does not dedent or reinterpret the source", async () => {
    expect(await guest.run('text = """\n    indented\n"""\nprint(repr(text))')).toMatchObject({ stdout: "'\\n    indented\\n'\n" });
    expect(await guest.run("    value = 1\nprint(value)")).toMatchObject({ status: 1 });
  });

  it("runs the functions registered with atexit before it ends", async () => {
    expect(await guest.run('import atexit\natexit.register(lambda: print("goodbye"))\nprint("working")')).toEqual({ status: 0, stdout: "working\ngoodbye\n", stderr: "" });
    expect(await guest.run('import atexit, sys\natexit.register(lambda: print("cleanup"))\nsys.exit(2)')).toMatchObject({ status: 2, stdout: "cleanup\n" });
  });

  it("reports the real process: id, user, group, directory and the environment of the VM minus its Python settings", async () => {
    const result = await guest.run("import os\nprint(os.getpid(), os.getuid(), os.geteuid(), os.getgid(), os.getegid(), os.getcwd())\nprint(os.environ.get('HOME'), os.environ.get('MPLBACKEND'), os.environ.get('FOO'), os.environ.get('PATH'), os.environ.get('PYTHONHOME'))");
    expect(result).toEqual({ status: 0, stdout: "4242 1000 1000 1001 1001 /workspace\n/home/user Agg bar /usr/bin None\n", stderr: "" });
  });

  it("works on the workspace's files, which Linux sees at once", async () => {
    const result = await guest.run('import os\nopen("made-by-python.txt", "w").write("written")\nprint(sorted(name for name in os.listdir(".") if name.endswith(".txt")))');
    expect(result.stdout).toBe("['made-by-python.txt']\n");
    expect(await readFile(guest.files.real("/workspace/made-by-python.txt"), "utf8")).toBe("written");
  });
});

describe("standard streams", () => {
  it("reads standard input, a line at a time and all at once, up to the end", async () => {
    expect(await guest.run("print(input().upper())\nprint(repr(input()))\nrest = __import__('sys').stdin.read()\nprint(len(rest))", { stdin: "first line\nsecond\nthe rest of it\nand more\n" }))
      .toEqual({ status: 0, stdout: "FIRST LINE\n'second'\n24\n", stderr: "" });
    expect(await guest.run("import sys\nprint(repr(sys.stdin.read()))")).toMatchObject({ stdout: "''\n" });
    const eof = await guest.run("input()");
    expect(eof.status).toBe(1);
    expect(eof.stderr).toContain("EOFError");
  });

  it("carries text in both directions as UTF-8", async () => {
    const result = await guest.run("import sys\nline = sys.stdin.readline()\nprint(line.strip(), '✓ héllo 日本語')\nprint('é', file=sys.stderr)", { stdin: "wörld ✓\n" });
    expect(result).toEqual({ status: 0, stdout: "wörld ✓ ✓ héllo 日本語\n", stderr: "é\n" });
  });

  it("delivers output that has no trailing newline and output printed with flush", async () => {
    expect(await guest.run('import sys\nsys.stdout.write("no newline")')).toMatchObject({ stdout: "no newline" });
    guest.stdio.writes.length = 0;
    const result = await guest.run('import sys\nprint("a", flush=True)\nprint("b", flush=True)\nprint("c")');
    expect(result.stdout).toBe("a\nb\nc\n");
    // The first two lines reached the descriptor as soon as they were flushed, not all together at the end.
    expect(guest.stdio.writes.length).toBeGreaterThanOrEqual(3);
  });

  it("carries a megabyte of output without loss", async () => {
    const result = await guest.run("for index in range(20000):\n    print('line %05d ' % index + 'x' * 40)\n");
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBe(20000 * 52);
    expect(result.stdout.startsWith("line 00000 ")).toBe(true);
    expect(result.stdout.endsWith(`line 19999 ${"x".repeat(40)}\n`)).toBe(true);
  });
});

describe("how the program was started, against CPython 3.14", () => {
  const MODULE = { executable: "/usr/local/bin/python3", version: PYTHON_VERSION };
  // Every recorded case that runs a program, or fails to read one. The one that ends with SIGINT is in signals.test.ts.
  const cases = oracle.cases.filter(recorded => recordedOutcome(recorded) === "run" && recorded.exit.kind === "exited");

  it("covers a file, -c and standard input, a traceback of each kind, and a file that cannot be read", () => {
    const names = cases.map(recorded => recorded.name);
    for (const name of ["file-with-arguments", "code-with-arguments", "stdin-dash-with-arguments", "stdin-without-arguments", "code-traceback", "stdin-traceback", "missing-file"]) expect(names).toContain(name);
  });

  for (const recorded of cases) {
    it(`${recorded.name}: sys.argv, sys.orig_argv, sys.executable, sys.path[0], __file__, the program name, output and status`, async () => {
      const result = await guest.runCommandLine(recorded.argv.slice(1), { cwd: oracle.provenance.cwd, stdin: recorded.stdin, argv0: oracle.provenance.argv0, executable: MODULE.executable });
      expect(result).toEqual({ status: recorded.exit.kind === "exited" ? recorded.exit.code : -1, stdout: normalised(recorded.stdout, MODULE), stderr: normalised(recorded.stderr, MODULE) });
    });
  }
});

describe("the interpreter between programs", () => {
  it("puts the program's place first on sys.path instead of Pyodide's empty entry, and restores sys.path afterwards", async () => {
    const before: unknown = guest.py.runPython("import sys, json\njson.dumps(sys.path)");
    const file = await guest.run("import sys\nprint(sys.path.count(''), sys.path[0])");
    expect(file).toEqual({ status: 0, stdout: "0 /workspace\n", stderr: "" });
    const code = await guest.runCommandLine(["-c", "import sys\nprint(sys.path.count(''), repr(sys.path[0]))"]);
    expect(code).toEqual({ status: 0, stdout: "1 ''\n", stderr: "" });
    expect(guest.py.runPython("import sys, json\njson.dumps(sys.path)")).toBe(before);
  });

  it("reports an empty sys.executable for an application start, which has no path", async () => {
    expect(await guest.runCommandLine(["-c", "import sys\nprint(repr(sys.executable), sys.orig_argv)"], { argv0: "pyodide", executable: "" })).toEqual({ status: 0, stdout: "'' ['pyodide', '-c', 'import sys\\nprint(repr(sys.executable), sys.orig_argv)']\n", stderr: "" });
  });

  it("forgets the source of a -c program once it has run", async () => {
    await guest.runCommandLine(["-c", "pass"]);
    expect(guest.py.runPython("import linecache\n'<string>' in linecache.cache")).toBe(false);
  });
});
