import type { ProcessExit, ProcessHandle, UserspaceVM } from "@oxidevm/sdk";
import { spawnModule } from "@oxidevm/sdk/wasm";
import type { ModuleHandle } from "@oxidevm/sdk/wasm";

/** What a scenario works with: the booted VM and the installed module. */
export interface Context {
  readonly vm: UserspaceVM;
  readonly pyodide: ModuleHandle;
}

export const decoder = new TextDecoder();
export const encoder = new TextEncoder();

export function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, milliseconds); });
}

export const describeExit = (exit: ProcessExit): string => (exit.kind === "exited" ? `exit ${String(exit.code)}` : `signal ${String(exit.signalNumber)}`);

/** JSON text with the keys of every object in sorted order, so that two equal values print equally. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${Array.from<unknown>(value).map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) return `{${Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return value === undefined ? "undefined" : JSON.stringify(value);
}

/** Throws unless `actual` is `expected` (objects compare by their fields, in any order); the message shows both. */
export function same(actual: unknown, expected: unknown, what: string): void {
  const left = canonical(actual), right = canonical(expected);
  if (left !== right) throw new Error(`${what}: expected ${right} but got ${left}`);
}

export function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(what);
}

/** Collects a stream as text while a scenario waits for a line or for the end. */
export class Capture {
  text = "";
  readonly done: Promise<void>;
  private readonly waiters: { readonly needle: string; readonly resolve: () => void }[] = [];

  constructor(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader(), decode = new TextDecoder();
    this.done = (async () => {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        this.text += decode.decode(part.value, { stream: true });
        for (const waiter of this.waiters.filter(candidate => this.text.includes(candidate.needle))) waiter.resolve();
      }
      this.text += decode.decode();
      for (const waiter of this.waiters.splice(0)) waiter.resolve();
    })();
  }

  /** Resolves once the text contains `needle`, or the stream has ended. */
  async waitFor(needle: string, timeoutMs = 120_000): Promise<void> {
    if (this.text.includes(needle)) return;
    const arrived = new Promise<void>(resolve => { this.waiters.push({ needle, resolve }); });
    const expired = sleep(timeoutMs).then(() => { throw new Error(`timed out after ${String(timeoutMs)} ms waiting for ${JSON.stringify(needle)}; so far: ${JSON.stringify(this.text.slice(-500))}`); });
    await Promise.race([arrived, expired]);
    if (!this.text.includes(needle)) throw new Error(`the stream ended before ${JSON.stringify(needle)}; it held ${JSON.stringify(this.text.slice(-500))}`);
  }
}

export interface Finished {
  readonly exit: ProcessExit;
  readonly stdout: string;
  readonly stderr: string;
  /** Milliseconds from the start of the module process to its end. */
  readonly ms: number;
}

export interface Running {
  readonly process: ProcessHandle;
  readonly stdout: Capture;
  readonly stderr: Capture;
  readonly finished: Promise<Finished>;
  /** Writes text to the process's standard input and closes it. */
  send(input: string): Promise<void>;
}

export interface StartOptions {
  /** The script is written to /workspace/_oxidevm/run-<name>.py (a name like pandas.py would shadow the package, as it does for `python`). */
  readonly name: string;
  readonly args?: readonly string[];
  /** The module's `packages` option; omit for its default. */
  readonly packages?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** Leave standard input open for the scenario to use (otherwise it is closed at once). */
  readonly keepInput?: boolean;
}

/** Writes a program into the workspace and starts the module on it. */
export async function start(context: Context, source: string, options: StartOptions): Promise<Running> {
  const path = `/workspace/_oxidevm/run-${options.name}.py`;
  await context.vm.workspace.writeText(`_oxidevm/run-${options.name}.py`, source);
  const began = performance.now();
  const process = await spawnModule(context.vm, context.pyodide, {
    args: [path, ...(options.args ?? [])],
    cwd: options.cwd ?? "/workspace",
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.packages === undefined ? {} : { options: { packages: options.packages } }),
  });
  const stdout = new Capture(process.stdout), stderr = new Capture(process.stderr);
  const writer = process.stdin.getWriter();
  const send = async (input: string): Promise<void> => {
    await writer.write(encoder.encode(input));
    await writer.close();
  };
  if (options.keepInput !== true) await writer.close();
  const finished = (async (): Promise<Finished> => {
    const exit = await process.exit;
    await Promise.all([stdout.done, stderr.done]);
    return { exit, stdout: stdout.text, stderr: stderr.text, ms: Math.round(performance.now() - began) };
  })();
  return { process, stdout, stderr, finished, send };
}

/** Runs a program to its end. */
export async function run(context: Context, source: string, options: StartOptions): Promise<Finished> {
  return (await start(context, source, options)).finished;
}

/** Throws unless the program ended with `status`; the message carries what it printed. */
export function expectStatus(result: Finished, status: number, what: string): void {
  if (result.exit.kind !== "exited" || result.exit.code !== status) {
    throw new Error(`${what}: expected exit ${String(status)} but got ${describeExit(result.exit)}\nstdout: ${result.stdout.slice(-800)}\nstderr: ${result.stderr.slice(-1500)}`);
  }
}

export interface Native {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a native Linux program in the VM and waits for it. */
export async function native(vm: UserspaceVM, command: string, args: readonly string[] = []): Promise<Native> {
  const result = await vm.exec({ command, args, cwd: "/workspace" });
  return { code: result.exit.kind === "exited" ? result.exit.code : -result.exit.signalNumber, stdout: decoder.decode(result.stdout), stderr: decoder.decode(result.stderr) };
}

/** The error a promise rejects with, as its code, stable reason and message. */
export async function failureOf(work: Promise<unknown>): Promise<{ readonly code: string; readonly reason: string; readonly message: string }> {
  try {
    await work;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
      const detail: unknown = "detail" in error ? error.detail : undefined;
      const reason = typeof detail === "object" && detail !== null && "reason" in detail ? String(detail.reason) : "";
      return { code: String(error.code), reason, message: String(error.message) };
    }
    throw error;
  }
  throw new Error("Expected the call to fail");
}

/** Hex SHA-256 of bytes, with the browser's own implementation. */
export async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice())), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** One field of a decoded JSON object, or `undefined` when the value is not an object or has no such field. */
export function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Reflect.get(value, key) : undefined;
}

/** A progress line for the page's console, which the Node side prints when OXIDEVM_VERBOSE is set. */
export function trace(message: string): void {
  console.info(`[scenario ${String(Math.round(performance.now()))} ms] ${message}`);
}

/** Waits for a program to end, and if it does not within `milliseconds`, kills it and says what it had printed. */
export async function finishWithin(running: Running, milliseconds: number): Promise<Finished> {
  const outcome = await Promise.race([running.finished.then(finished => ({ finished })), sleep(milliseconds).then(() => ({ finished: undefined }))]);
  if (outcome.finished !== undefined) return outcome.finished;
  await running.process.kill("SIGKILL", { scope: "process-group" }).catch(() => undefined);
  throw new Error(`the program did not finish within ${String(milliseconds)} ms; standard output so far: ${JSON.stringify(running.stdout.text)}; standard error so far: ${JSON.stringify(running.stderr.text)}`);
}
