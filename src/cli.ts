// The command line, read the way CPython 3.14 reads its own (Python/getopt.c and config_parse_cmdline in
// Python/initconfig.c), for the options this module takes. test/cli.test.ts compares it with what a real CPython 3.14
// did with the same command lines (test/fixtures/cpython-cli.json, recorded by scripts/record-cpython-cli.py).

/** The CPython version of the bundled Pyodide; test/cli.test.ts checks it against Pyodide's lock. */
export const PYTHON_VERSION = "3.14.2";

/** What the program is: a file as typed, the text after -c, or standard input. */
export type Program =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "code"; readonly code: string }
  | { readonly kind: "stdin" };

export type CommandLine =
  | {
    readonly kind: "run";
    readonly program: Program;
    /** `sys.argv`: the file as typed, `-c` or `-`, then the program's own arguments; `[""]` without any. */
    readonly argv: readonly string[];
    /** `-i` was given: the interactive interpreter after the program. */
    readonly interactive: boolean;
    /** Lines CPython prints on standard error and then carries on (an empty long option in a group of flags). */
    readonly warnings: readonly string[];
  }
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "usage-error"; readonly message: string };

/** Options CPython has that change nothing here: PYTHON* variables are dropped anyway, and there is no REPL to quiet. */
const IGNORED = new Set(["u", "B", "E", "s", "I", "P", "q"]);

type Options = { interactive: boolean; version: boolean; warnings: string[] };
type Step = { readonly kind: "next" } | { readonly kind: "stop" } | { readonly kind: "code"; readonly code: string } | Extract<CommandLine, { kind: "help" | "usage-error" }>;

/**
 * One argument that starts with a dash: a group of one-letter flags, where `-c` takes the rest of the group or the next
 * argument, and a `-` inside the group starts a long option (none of CPython's is taken here).
 */
function readGroup(arg: string, rest: string[], options: Options): Step {
  for (let index = 1; index < arg.length; index += 1) {
    const option = arg.charAt(index);
    if (option === "-") {
      if (index + 1 < arg.length) return { kind: "usage-error", message: `Unknown option: ${arg}` };
      options.warnings.push("Expected long option");
      return { kind: "stop" };
    }
    if (option === "c") {
      const attached = arg.slice(index + 1);
      if (attached !== "") return { kind: "code", code: attached };
      const next = rest.shift();
      return next === undefined ? { kind: "usage-error", message: "Argument expected for the -c option" } : { kind: "code", code: next };
    }
    if (option === "h") return { kind: "help" };
    if (option === "V") options.version = true;
    else if (option === "i") options.interactive = true;
    else if (!IGNORED.has(option)) return { kind: "usage-error", message: `Unknown option: -${option}` };
  }
  return { kind: "next" };
}

/** Reads the arguments after argv[0]. Option parsing stops at the program file, at `-`, at `--` and after `-c`. */
export function parseCommandLine(args: readonly string[]): CommandLine {
  const rest = [...args];
  const options: Options = { interactive: false, version: false, warnings: [] };
  let code: string | undefined;
  for (let arg = rest[0]; arg !== undefined && arg.startsWith("-") && arg !== "-"; arg = rest[0]) {
    rest.shift();
    if (arg === "--") break;
    if (arg === "--help") return { kind: "help" };
    if (arg === "--version") { options.version = true; continue; }
    const step = readGroup(arg, rest, options);
    if (step.kind === "help" || step.kind === "usage-error") return step;
    if (step.kind === "code") { code = step.code; break; }
    if (step.kind === "stop") break;
  }
  if (options.version) return { kind: "version" };
  const run = { interactive: options.interactive, warnings: options.warnings };
  if (code !== undefined) return { kind: "run", program: { kind: "code", code }, argv: ["-c", ...rest], ...run };
  const [first] = rest;
  if (first === undefined) return { kind: "run", program: { kind: "stdin" }, argv: [""], ...run };
  if (first === "-") return { kind: "run", program: { kind: "stdin" }, argv: rest, ...run };
  return { kind: "run", program: { kind: "file", path: first }, argv: rest, ...run };
}

function usageLine(argv0: string): string {
  return `usage: ${argv0} [option] ... [-c cmd | -m mod | file | -] [arg] ...`;
}

/** What CPython prints for a command line it cannot use, word for word (its last line names `python`, not argv[0]). */
export function usageError(argv0: string, message: string): string {
  return `${message}\n${usageLine(argv0)}\nTry \`python -h' for more information.\n`;
}

export function versionText(): string {
  return `Python ${PYTHON_VERSION}\n`;
}

/** The help: CPython's usage line, then what this command takes and what it does not take yet. */
export function helpText(argv0: string): string {
  return `${usageLine(argv0)}
Python ${PYTHON_VERSION} in Pyodide, run by an OxideVM WebAssembly module. Options:
-c cmd : program passed in as string (terminates option list)
-h     : print this help message and exit (also --help)
-V     : print the Python version number and exit (also --version)
-u, -B, -E, -s, -I, -P, -q : accepted and ignored: PYTHON* environment variables are
         never passed on, so -E and -I change nothing
file   : program read from script file
-      : program read from stdin (default when standard input is not a terminal)
arg ...: arguments passed to program in sys.argv[1:]

Not supported yet: the interactive interpreter (no program, or -i, with a terminal on
standard input), -m and CPython's other options.
`;
}

/**
 * Why the command line cannot run without the interactive interpreter, which this module does not have yet: CPython
 * would start it for a program read from a terminal, and after any program for `-i`.
 */
export function interactiveRefusal(argv0: string, line: Extract<CommandLine, { kind: "run" }>, stdinIsTerminal: boolean): string | undefined {
  if (!line.interactive && !(line.program.kind === "stdin" && stdinIsTerminal)) return undefined;
  return `${argv0}: the interactive interpreter is not supported yet; use FILE, -c CODE or -`;
}
