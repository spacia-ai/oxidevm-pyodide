import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, isStringArray } from "../../src/records.ts";

/** How a recorded CPython process ended. */
export type OracleExit = { readonly kind: "exited"; readonly code: number } | { readonly kind: "signaled"; readonly signal: string };

/** One command line as real CPython 3.14 handled it (see scripts/record-cpython-cli.py). */
export interface OracleCase {
  readonly name: string;
  /** argv[0] ("python3"), then the arguments. */
  readonly argv: readonly string[];
  readonly stdin: string;
  /** All of standard output, or only its first line for the help cases. */
  readonly stdout: string;
  readonly stdoutKept: "all" | "first-line";
  readonly stderr: string;
  readonly exit: OracleExit;
}

export interface Oracle {
  readonly provenance: {
    readonly interpreter: string;
    readonly version: string;
    /** The directory every case ran in; the files are under it. */
    readonly cwd: string;
    readonly argv0: string;
    /** What CPython reported as sys.executable: the interpreter path that the tests replace with the command's. */
    readonly executable: string;
  };
  /** The programs the cases run, by path relative to `cwd`. */
  readonly files: Readonly<Record<string, string>>;
  readonly cases: readonly OracleCase[];
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Error(`cpython-cli.json: ${what} must be text`);
  return value;
}

function decodeExit(value: unknown, what: string): OracleExit {
  if (!isRecord(value)) throw new Error(`cpython-cli.json: ${what} must be an object`);
  if (value["kind"] === "exited" && typeof value["code"] === "number") return { kind: "exited", code: value["code"] };
  if (value["kind"] === "signaled") return { kind: "signaled", signal: text(value["signal"], `${what}.signal`) };
  throw new Error(`cpython-cli.json: ${what} is not an exit`);
}

function decodeCase(value: unknown, index: number): OracleCase {
  const what = `cases[${String(index)}]`;
  if (!isRecord(value)) throw new Error(`cpython-cli.json: ${what} must be an object`);
  const argv = value["argv"], kept = value["stdoutKept"];
  if (!isStringArray(argv) || argv.length === 0) throw new Error(`cpython-cli.json: ${what}.argv must be a nonempty list of text`);
  if (kept !== "all" && kept !== "first-line") throw new Error(`cpython-cli.json: ${what}.stdoutKept is unknown`);
  return {
    name: text(value["name"], `${what}.name`), argv, stdin: text(value["stdin"], `${what}.stdin`), stdout: text(value["stdout"], `${what}.stdout`),
    stdoutKept: kept, stderr: text(value["stderr"], `${what}.stderr`), exit: decodeExit(value["exit"], `${what}.exit`),
  };
}

function decodeOracle(value: unknown): Oracle {
  if (!isRecord(value) || value["schemaVersion"] !== 1) throw new Error("cpython-cli.json: schemaVersion 1 expected");
  const provenance = value["provenance"], files = value["files"], cases = value["cases"];
  if (!isRecord(provenance) || !isRecord(files) || !Array.isArray(cases)) throw new Error("cpython-cli.json: provenance, files and cases expected");
  return {
    provenance: {
      interpreter: text(provenance["interpreter"], "provenance.interpreter"), version: text(provenance["version"], "provenance.version"),
      cwd: text(provenance["cwd"], "provenance.cwd"), argv0: text(provenance["argv0"], "provenance.argv0"), executable: text(provenance["executable"], "provenance.executable"),
    },
    files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, text(content, `files.${name}`)])),
    cases: Array.from<unknown>(cases).map(decodeCase),
  };
}

/** The recorded behaviour of CPython 3.14 (test/fixtures/cpython-cli.json). */
export const oracle: Oracle = decodeOracle(JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../fixtures/cpython-cli.json"), "utf8")));

/** The recorded case with this name. */
export function oracleCase(name: string): OracleCase {
  const found = oracle.cases.find(item => item.name === name);
  if (found === undefined) throw new Error(`cpython-cli.json has no case ${name}`);
  return found;
}

/**
 * Text as the module would print it for the same command line: the recorded interpreter's path becomes the command's
 * path, and its version the module's. Nothing else is changed.
 */
export function normalised(recorded: string, module: { readonly executable: string; readonly version: string }): string {
  return recorded.replaceAll(oracle.provenance.executable, module.executable).replaceAll(`Python ${oracle.provenance.version}`, `Python ${module.version}`);
}

/** What CPython's option parser did with a case, read from the recording rather than from the module's parser. */
export type RecordedOutcome = "version" | "help" | "usage-error" | "run";

export function recordedOutcome(recorded: OracleCase): RecordedOutcome {
  if (/^(Unknown option|Argument expected)/u.test(recorded.stderr) && recorded.stderr.includes(`\nusage: ${oracle.provenance.argv0} `)) return "usage-error";
  if (recorded.exit.kind === "exited" && recorded.exit.code === 0 && /^Python \d+\.\d+\.\d+\n$/u.test(recorded.stdout)) return "version";
  if (recorded.exit.kind === "exited" && recorded.exit.code === 0 && recorded.stdout.startsWith("usage: ")) return "help";
  return "run";
}

/** The recorded programs, by their VM path (under /tmp, where the recording ran). */
export function oracleFiles(): readonly (readonly [path: string, text: string])[] {
  return Object.entries(oracle.files).map(([name, text]) => [`${oracle.provenance.cwd}/${name}`, text]);
}
