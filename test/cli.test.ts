import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { helpText, parseCommandLine, PYTHON_VERSION, usageError, versionText } from "../src/cli.ts";
import { startsWithPrompt } from "../src/script.ts";
import type { CommandLine } from "../src/cli.ts";
import { isStringArray } from "../src/records.ts";
import { field } from "./support/decode.ts";
import { normalised, oracle, recordedOutcome } from "./support/cpython-oracle.ts";
import type { OracleCase } from "./support/cpython-oracle.ts";

// The parser against what real CPython 3.14 did with the same command lines (test/fixtures/cpython-cli.json, recorded
// by scripts/record-cpython-cli.py). Only the interpreter path and the version text are normalised. What the program
// then sees (sys.argv and the rest at run time) is compared in test/command.test.ts.

const ARGV0 = oracle.provenance.argv0;
const MODULE = { executable: "/usr/local/bin/python3", version: PYTHON_VERSION };

/** The probe's report of how it was started, when the case ran the probe. */
function probeReport(recorded: OracleCase): unknown {
  if (!recorded.stdout.startsWith("{\"argv\"")) return undefined;
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
          const argv = field(report, "argv");
          const filename = field(report, "filename");
          const program = line.program;
          if (program.kind === "module") {
            // runpy puts the module's file in place of -m once it has found it.
            expect(line.argv).toEqual(["-m", ...(isStringArray(argv) ? argv.slice(1) : ["(not a list of text)"])]);
            expect(filename).toMatch(new RegExp(`/${program.module.replaceAll(".", "/")}(/__main__)?\\.py$`, "u"));
            break;
          }
          expect(line.argv).toEqual(argv);
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
  it("takes -m like -c: the rest of the group or the next argument, ending the options", () => {
    for (const args of [["-m", "json.tool", "-c", "x"], ["-mjson.tool", "-c", "x"], ["-um", "json.tool", "-c", "x"]]) {
      expect(parseCommandLine(args), args.join(" ")).toEqual({ kind: "run", program: { kind: "module", module: "json.tool" }, argv: ["-m", "-c", "x"], interactive: false, quiet: false, warnings: [] });
    }
    expect(parseCommandLine(["-m"])).toEqual({ kind: "usage-error", message: "Argument expected for the -m option" });
    expect(parseCommandLine(["-ium"])).toEqual({ kind: "usage-error", message: "Argument expected for the -m option" });
    expect(runOf(parseCommandLine(["-c", "pass", "-m", "x"]))).toMatchObject({ program: { kind: "code", code: "pass" }, argv: ["-c", "-m", "x"] });
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

  it("accepts -u, -B, -E, -s, -I and -P, alone or grouped, and changes nothing for them", () => {
    const plain = parseCommandLine(["x.py", "a"]);
    for (const args of [["-u"], ["-B"], ["-E"], ["-s"], ["-I"], ["-P"], ["-uBEsIP"], ["-u", "-I", "-P"]]) {
      expect(parseCommandLine([...args, "x.py", "a"]), args.join(" ")).toEqual(plain);
    }
    expect(plain).toEqual({ kind: "run", program: { kind: "file", path: "x.py" }, argv: ["x.py", "a"], interactive: false, quiet: false, warnings: [] });
  });

  it("notes -q, which leaves out the interactive interpreter's banner", () => {
    expect(runOf(parseCommandLine(["-q", "x.py"]))).toMatchObject({ quiet: true, interactive: false });
    expect(runOf(parseCommandLine(["-uqi"]))).toMatchObject({ quiet: true, interactive: true, program: { kind: "stdin" } });
  });

  it("notes -i, which asks for the interactive interpreter after the program, wherever it appears among the options", () => {
    expect(runOf(parseCommandLine(["-i", "x.py"]))).toMatchObject({ interactive: true, program: { kind: "file", path: "x.py" } });
    expect(runOf(parseCommandLine(["-uic", "pass"]))).toMatchObject({ interactive: true, program: { kind: "code", code: "pass" }, argv: ["-c"] });
    expect(runOf(parseCommandLine(["-i"]))).toMatchObject({ interactive: true, program: { kind: "stdin" }, argv: [""] });
    expect(runOf(parseCommandLine(["-i", "-m", "json.tool"]))).toMatchObject({ interactive: true, program: { kind: "module", module: "json.tool" } });
  });

  it("stops at -c: what follows its argument belongs to the program, even -V, -h and -i", () => {
    expect(parseCommandLine(["-c", "pass", "-V", "-h", "-i", "-Z"])).toEqual({ kind: "run", program: { kind: "code", code: "pass" }, argv: ["-c", "-V", "-h", "-i", "-Z"], interactive: false, quiet: false, warnings: [] });
    expect(runOf(parseCommandLine(["-c", "-Z"]))).toMatchObject({ program: { kind: "code", code: "-Z" }, argv: ["-c"] });
  });

  it("reads the program from standard input after -- -, and runs a file named - only through a path", () => {
    expect(parseCommandLine(["--", "-", "a"])).toEqual({ kind: "run", program: { kind: "stdin" }, argv: ["-", "a"], interactive: false, quiet: false, warnings: [] });
    expect(runOf(parseCommandLine(["./-", "a"]))).toMatchObject({ program: { kind: "file", path: "./-" }, argv: ["./-", "a"] });
    expect(runOf(parseCommandLine(["--", "--"]))).toMatchObject({ program: { kind: "file", path: "--" }, argv: ["--"] });
  });
});

describe("when the interactive interpreter starts without a program", () => {
  it("starts for a program from a terminal: no arguments, -, or -- with a terminal on standard input", () => {
    for (const args of [[], ["-"], ["--"], ["-", "a"], ["-u"], ["-q"]]) expect(startsWithPrompt(runOf(parseCommandLine(args)), true), args.join(" ")).toBe(true);
  });

  it("starts for -i without a program whatever standard input is, as CPython prompts on a pipe then", () => {
    for (const args of [["-i"], ["-i", "-"]]) {
      expect(startsWithPrompt(runOf(parseCommandLine(args)), false), args.join(" ")).toBe(true);
      expect(startsWithPrompt(runOf(parseCommandLine(args)), true), args.join(" ")).toBe(true);
    }
  });

  it("does not start first for a file, -c or -m, nor for a program piped in", () => {
    for (const args of [["x.py"], ["-c", "pass"], ["-m", "x"], ["-i", "x.py"], ["-i", "-c", "pass"]]) expect(startsWithPrompt(runOf(parseCommandLine(args)), true), args.join(" ")).toBe(false);
    for (const args of [[], ["-"], ["-", "a"]]) expect(startsWithPrompt(runOf(parseCommandLine(args)), false), args.join(" ")).toBe(false);
  });
});

describe("the texts", () => {
  it("name argv[0] in the usage line and keep CPython's own words otherwise", () => {
    expect(usageError("pyodide", "Unknown option: -Z")).toBe("Unknown option: -Z\nusage: pyodide [option] ... [-c cmd | -m mod | file | -] [arg] ...\nTry `python -h' for more information.\n");
  });

  it("help starts with the usage line, says what works, and says what does not", () => {
    const help = helpText("python");
    expect(help.split("\n")[0]).toBe("usage: python [option] ... [-c cmd | -m mod | file | -] [arg] ...");
    for (const option of ["-c cmd", "-h", "-i", "-m mod", "-q", "-V", "-u", "-B", "-E", "-s", "-I", "-P", "file", "-  "]) expect(help, option).toContain(option);
    expect(help).toContain("basic REPL");
    expect(help.endsWith("\n")).toBe(true);
  });
});
