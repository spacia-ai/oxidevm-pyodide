import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { helpText, interactiveRefusal, parseCommandLine, PYTHON_VERSION, usageError, versionText } from "../src/cli.ts";
import type { CommandLine } from "../src/cli.ts";
import { field } from "./support/decode.ts";
import { normalised, oracle } from "./support/cpython-oracle.ts";
import type { OracleCase } from "./support/cpython-oracle.ts";

// The parser against what real CPython 3.14 did with the same command lines (test/fixtures/cpython-cli.json, recorded
// by scripts/record-cpython-cli.py). Only the interpreter path and the version text are normalised. What the program
// then sees (sys.argv and the rest at run time) is compared in test/command.test.ts.

const ARGV0 = oracle.provenance.argv0;
const MODULE = { executable: "/usr/local/bin/python3", version: PYTHON_VERSION };

type Expected = "version" | "help" | "usage-error" | "run";

/** What CPython's own option parser did, read from the recording rather than from the module's parser. */
function recordedOutcome(recorded: OracleCase): Expected {
  if (/^(Unknown option|Argument expected)/u.test(recorded.stderr) && recorded.stderr.includes(`\nusage: ${ARGV0} `)) return "usage-error";
  if (recorded.exit.kind === "exited" && recorded.exit.code === 0 && /^Python \d+\.\d+\.\d+\n$/u.test(recorded.stdout)) return "version";
  if (recorded.exit.kind === "exited" && recorded.exit.code === 0 && recorded.stdout.startsWith("usage: ")) return "help";
  return "run";
}

/** The probe's report of how it was started, when the case ran the probe. */
function probeReport(recorded: OracleCase): unknown {
  if (!recorded.stdout.startsWith("{")) return undefined;
  const report: unknown = JSON.parse(recorded.stdout);
  return report;
}

function runOf(line: CommandLine): Extract<CommandLine, { kind: "run" }> {
  if (line.kind !== "run") throw new Error(`expected a program to run, got ${line.kind}`);
  return line;
}

describe("the command line, against CPython 3.14", () => {
  it("covers every way of starting a program and every refusal the brief names", () => {
    expect(new Set(oracle.cases.map(recordedOutcome))).toEqual(new Set(["version", "help", "usage-error", "run"]));
    expect(oracle.provenance.version).toMatch(/^3\.14\.\d+$/u);
  });

  for (const recorded of oracle.cases) {
    it(`${recorded.name}: ${JSON.stringify(recorded.argv.slice(1)).slice(0, 80)}`, () => {
      const line = parseCommandLine(recorded.argv.slice(1));
      const expected = recordedOutcome(recorded);
      expect(line.kind).toBe(expected);
      switch (line.kind) {
        case "version":
          expect([normalised(recorded.stdout, MODULE), recorded.stderr]).toEqual([versionText(), ""]);
          break;
        case "help":
          expect(recorded.stdoutKept).toBe("first-line");
          expect(recorded.stdout).toBe(`${helpText(ARGV0).split("\n")[0] ?? ""}\n`);
          break;
        case "usage-error":
          expect([recorded.stdout, recorded.stderr]).toEqual(["", usageError(ARGV0, line.message)]);
          expect(recorded.exit).toEqual({ kind: "exited", code: 2 });
          break;
        case "run": {
          // A warning of the parser is the only text CPython printed before the program's own output.
          expect(line.warnings.map(warning => `${warning}\n`).join("")).toBe(recorded.stderr.startsWith("Expected long option\n") ? "Expected long option\n" : "");
          const report = probeReport(recorded);
          if (report === undefined) break;
          expect(line.argv).toEqual(field(report, "argv"));
          const filename = field(report, "filename");
          const program = line.program;
          if (filename === "<string>") expect(program).toEqual({ kind: "code", code: oracle.files["sub/probe.py"]?.trimEnd() });
          else if (filename === "<stdin>") expect(program).toEqual({ kind: "stdin" });
          else expect(program.kind === "file" ? `${oracle.provenance.cwd}/${program.path}` : program.kind).toBe(filename);
          break;
        }
      }
    });
  }

  it("prints the version that Pyodide's own lock gives its CPython", async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const lock: unknown = JSON.parse(await readFile(join(root, "upstream/pyodide-lock.json"), "utf8"));
    expect(field(field(lock, "info"), "python")).toBe(PYTHON_VERSION);
    expect(versionText()).toBe(`Python ${PYTHON_VERSION}\n`);
  });
});

describe("what the module refuses or ignores, where CPython would do more", () => {
  it("refuses -m, which CPython would take as a module to run, with CPython's text for an unknown option", () => {
    for (const args of [["-m", "json.tool"], ["-m"], ["-mjson.tool"], ["-um", "json.tool"]]) {
      expect(parseCommandLine(args), args.join(" ")).toEqual({ kind: "usage-error", message: "Unknown option: -m" });
    }
  });

  it("refuses every other option of CPython's, short or long", () => {
    for (const option of ["b", "d", "O", "R", "S", "t", "v", "W", "x", "X", "J", "?"]) {
      expect(parseCommandLine([`-${option}`, "x.py"]), option).toEqual({ kind: "usage-error", message: `Unknown option: -${option}` });
    }
    expect(parseCommandLine(["-Wignore", "x.py"])).toEqual({ kind: "usage-error", message: "Unknown option: -W" });
    for (const option of ["--help-all", "--help-env", "--help-xoptions", "--check-hash-based-pycs", "--verbose", "---"]) {
      expect(parseCommandLine([option]), option).toEqual({ kind: "usage-error", message: `Unknown option: ${option}` });
    }
  });

  it("accepts -u, -B, -E, -s, -I, -P and -q, alone or grouped, and changes nothing for them", () => {
    const plain = parseCommandLine(["x.py", "a"]);
    for (const args of [["-u"], ["-B"], ["-E"], ["-s"], ["-I"], ["-P"], ["-q"], ["-uBEsIPq"], ["-u", "-I", "-P"]]) {
      expect(parseCommandLine([...args, "x.py", "a"]), args.join(" ")).toEqual(plain);
    }
    expect(plain).toEqual({ kind: "run", program: { kind: "file", path: "x.py" }, argv: ["x.py", "a"], interactive: false, warnings: [] });
  });

  it("notes -i, which asks for the interactive interpreter after the program, wherever it appears among the options", () => {
    expect(runOf(parseCommandLine(["-i", "x.py"]))).toMatchObject({ interactive: true, program: { kind: "file", path: "x.py" } });
    expect(runOf(parseCommandLine(["-uic", "pass"]))).toMatchObject({ interactive: true, program: { kind: "code", code: "pass" }, argv: ["-c"] });
    expect(runOf(parseCommandLine(["-i"]))).toMatchObject({ interactive: true, program: { kind: "stdin" }, argv: [""] });
  });

  it("stops at -c: what follows its argument belongs to the program, even -V, -h and -i", () => {
    expect(parseCommandLine(["-c", "pass", "-V", "-h", "-i", "-Z"])).toEqual({ kind: "run", program: { kind: "code", code: "pass" }, argv: ["-c", "-V", "-h", "-i", "-Z"], interactive: false, warnings: [] });
    expect(runOf(parseCommandLine(["-c", "-Z"]))).toMatchObject({ program: { kind: "code", code: "-Z" }, argv: ["-c"] });
  });

  it("reads the program from standard input after -- -, and runs a file named - only through a path", () => {
    expect(parseCommandLine(["--", "-", "a"])).toEqual({ kind: "run", program: { kind: "stdin" }, argv: ["-", "a"], interactive: false, warnings: [] });
    expect(runOf(parseCommandLine(["./-", "a"]))).toMatchObject({ program: { kind: "file", path: "./-" }, argv: ["./-", "a"] });
    expect(runOf(parseCommandLine(["--", "--"]))).toMatchObject({ program: { kind: "file", path: "--" }, argv: ["--"] });
  });
});

describe("the interactive interpreter, which the module does not have yet", () => {
  const refusal = `${ARGV0}: the interactive interpreter is not supported yet; use FILE, -c CODE or -`;

  it("is refused for a program from a terminal: no arguments, -, or -- with a terminal on standard input", () => {
    for (const args of [[], ["-"], ["--"], ["-", "a"], ["-u"]]) expect(interactiveRefusal(ARGV0, runOf(parseCommandLine(args)), true), args.join(" ")).toBe(refusal);
  });

  it("is refused for -i whatever standard input is, because -i asks for it after any program", () => {
    for (const args of [["-i", "x.py"], ["-i", "-c", "pass"], ["-i"]]) {
      expect(interactiveRefusal(ARGV0, runOf(parseCommandLine(args)), false), args.join(" ")).toBe(refusal);
      expect(interactiveRefusal(ARGV0, runOf(parseCommandLine(args)), true), args.join(" ")).toBe(refusal);
    }
  });

  it("is not needed for a file, for -c, or for a program piped in", () => {
    for (const args of [["x.py"], ["-c", "pass"]]) expect(interactiveRefusal(ARGV0, runOf(parseCommandLine(args)), true), args.join(" ")).toBeUndefined();
    for (const args of [[], ["-"], ["-", "a"]]) expect(interactiveRefusal(ARGV0, runOf(parseCommandLine(args)), false), args.join(" ")).toBeUndefined();
  });

  it("names the command as it was typed", () => {
    expect(interactiveRefusal("/usr/local/bin/python", runOf(parseCommandLine([])), true)).toBe("/usr/local/bin/python: the interactive interpreter is not supported yet; use FILE, -c CODE or -");
  });
});

describe("the texts", () => {
  it("name argv[0] in the usage line and keep CPython's own words otherwise", () => {
    expect(usageError("pyodide", "Unknown option: -Z")).toBe("Unknown option: -Z\nusage: pyodide [option] ... [-c cmd | -m mod | file | -] [arg] ...\nTry `python -h' for more information.\n");
  });

  it("help starts with the usage line, says what works, and says what does not", () => {
    const help = helpText("python");
    expect(help.split("\n")[0]).toBe("usage: python [option] ... [-c cmd | -m mod | file | -] [arg] ...");
    for (const option of ["-c cmd", "-h", "-V", "-u", "-B", "-E", "-s", "-I", "-P", "-q", "file", "-  "]) expect(help, option).toContain(option);
    expect(help).toContain("-m");
    expect(help).toContain("interactive interpreter");
    expect(help.endsWith("\n")).toBe(true);
  });
});
