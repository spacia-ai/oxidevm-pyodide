// The command line, read the way CPython 3.14 reads its own (Python/getopt.c and config_parse_cmdline in
// Python/initconfig.c), for the options this module takes. test/cli.test.ts compares it with what a real CPython 3.14
// did with the same command lines (test/fixtures/cpython-cli.json, recorded by scripts/record-cpython-cli.py).

/** The CPython version of the bundled Pyodide; test/cli.test.ts checks it against Pyodide's lock. */
export const PYTHON_VERSION = "3.14.2";

/** What the program is: a file as typed, the text after -c, a module named by -m, or standard input. */
export type Program =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "code"; readonly code: string }
  | { readonly kind: "module"; readonly module: string }
  | { readonly kind: "stdin" };

export type CommandLine =
  | {
    readonly kind: "run";
    readonly program: Program;
    /**
     * `sys.argv`: the file as typed, `-c`, `-m` or `-`, then the program's own arguments; `[""]` without any. For -m,
     * runpy replaces `-m` with the module's file once it finds it, as CPython does.
     */
    readonly argv: readonly string[];
    /** `-i` was given: the interactive interpreter after the program. */
    readonly interactive: boolean;
    /** `-q` was given: the interactive interpreter starts without its banner. */
    readonly quiet: boolean;
    /** Lines CPython prints on standard error and then carries on (an empty long option in a group of flags). */
    readonly warnings: readonly string[];
  }
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "usage-error"; readonly message: string };

/** Options CPython has that change nothing here: PYTHON* variables are dropped anyway. */
const IGNORED = new Set(["u", "B", "E", "s", "I", "P"]);

type Options = { interactive: boolean; quiet: boolean; version: boolean; warnings: string[] };
/** An option that takes the rest of its group or the next argument, and ends the options: -c CODE or -m MODULE. */
type Final = { readonly kind: "code"; readonly code: string } | { readonly kind: "module"; readonly module: string };
type Step = { readonly kind: "next" } | { readonly kind: "stop" } | { readonly kind: "final"; readonly program: Final } | Extract<CommandLine, { kind: "help" | "usage-error" }>;

/**
 * One argument that starts with a dash: a group of one-letter flags, where `-c` and `-m` take the rest of the group or the
 * next argument, and a `-` inside the group starts a long option (none of CPython's is taken here).
 */
function readGroup(arg: string, rest: string[], options: Options): Step {
  for (let index = 1; index < arg.length; index += 1) {
    const option = arg.charAt(index);
    if (option === "-") {
      if (index + 1 < arg.length) return { kind: "usage-error", message: `Unknown option: ${arg}` };
      options.warnings.push("Expected long option");
      return { kind: "stop" };
    }
    if (option === "c" || option === "m") {
      const attached = arg.slice(index + 1);
      const value = attached !== "" ? attached : rest.shift();
      if (value === undefined) return { kind: "usage-error", message: `Argument expected for the -${option} option` };
      return { kind: "final", program: option === "c" ? { kind: "code", code: value } : { kind: "module", module: value } };
    }
    if (option === "h") return { kind: "help" };
    if (option === "V") options.version = true;
    else if (option === "i") options.interactive = true;
    else if (option === "q") options.quiet = true;
    else if (!IGNORED.has(option)) return { kind: "usage-error", message: `Unknown option: -${option}` };
  }
  return { kind: "next" };
}

/** Reads the arguments after argv[0]. Option parsing stops at the program file, at `-`, at `--` and after `-c` or `-m`. */
export function parseCommandLine(args: readonly string[]): CommandLine {
  const rest = [...args];
  const options: Options = { interactive: false, quiet: false, version: false, warnings: [] };
  let final: Final | undefined;
  for (let arg = rest[0]; arg !== undefined && arg.startsWith("-") && arg !== "-"; arg = rest[0]) {
    rest.shift();
    if (arg === "--") break;
    if (arg === "--help") return { kind: "help" };
    if (arg === "--version") { options.version = true; continue; }
    const step = readGroup(arg, rest, options);
    if (step.kind === "help" || step.kind === "usage-error") return step;
    if (step.kind === "final") { final = step.program; break; }
    if (step.kind === "stop") break;
  }
  if (options.version) return { kind: "version" };
  const run = { interactive: options.interactive, quiet: options.quiet, warnings: options.warnings };
  if (final !== undefined) return { kind: "run", program: final, argv: [final.kind === "code" ? "-c" : "-m", ...rest], ...run };
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

/** The help: CPython's usage line, then what this command takes. */
export function helpText(argv0: string): string {
  return `${usageLine(argv0)}
Python ${PYTHON_VERSION} in Pyodide, run by an OxideVM WebAssembly module. Options:
-c cmd : program passed in as string (terminates option list)
-h     : print this help message and exit (also --help)
-i     : inspect interactively after running script; forces a prompt even
         if stdin does not appear to be a terminal
-m mod : run library module as a script (terminates option list)
-q     : don't print version and copyright messages on interactive startup
-V     : print the Python version number and exit (also --version)
-u, -B, -E, -s, -I, -P : accepted and ignored: PYTHON* environment variables are
         never passed on, so -E and -I change nothing
file   : program read from script file
-      : program read from stdin (default; interactive mode if a tty)
arg ...: arguments passed to program in sys.argv[1:]

The interactive interpreter is CPython's basic REPL: the terminal edits the line, and
there is no history or completion. CPython's other options are not supported.
`;
}
