import type { ProcessSignals, SignalTrap } from "@oxidevm/sdk/wasm";
import { ModuleError } from "./errors.ts";

/** The JavaScript function, imported by Pyodide's interpreter, with which CPython polls the interrupt buffer. */
export const SIGNAL_POLL_IMPORT = "_Py_CheckEmscriptenSignals_Helper";

/** The integer arrays `Atomics` works on that a Pyodide interrupt buffer can be. */
function isAtomicBuffer(value: unknown): value is Int32Array | Int16Array | Int8Array | Uint32Array | Uint16Array | Uint8Array {
  return value instanceof Int32Array || value instanceof Int16Array || value instanceof Int8Array
    || value instanceof Uint32Array || value instanceof Uint16Array || value instanceof Uint8Array;
}

/**
 * Takes the pending signal out of an interrupt buffer in one step and returns it, or 0. Pyodide's own poll reads the
 * buffer and then writes 0 to it, so a Ctrl+C that the runtime writes between the two is lost; an exchange cannot lose
 * one. Like Pyodide's poll, anything that is not an integer array holds no signal.
 */
export function takeSignal(buffer: unknown): number {
  return isAtomicBuffer(buffer) ? Atomics.exchange(buffer, 0, 0) : 0;
}

/**
 * Replaces the interpreter's import `SIGNAL_POLL_IMPORT` with one that takes the signal (`takeSignal`) from the buffer
 * that Pyodide's `setInterruptBuffer` stores on `module`, the settings object its Emscripten factory was given. Call it
 * on the interpreter's imports before it is instantiated (`withPreparedImports` in src/python-loader.ts); Pyodide's files
 * stay unmodified. An interpreter that does not import the poll is refused rather than run with one that loses Ctrl+C.
 */
export function useAtomicSignalPoll(imports: Readonly<Record<string, unknown>>, module: object): void {
  const env: unknown = imports["env"];
  if (typeof env !== "object" || env === null || typeof Reflect.get(env, SIGNAL_POLL_IMPORT) !== "function") {
    throw new ModuleError("interpreter-imports", `Pyodide's interpreter imports no ${SIGNAL_POLL_IMPORT}`);
  }
  Reflect.set(env, SIGNAL_POLL_IMPORT, () => takeSignal(Reflect.get(module, "Py_EmscriptenSignalBuffer")));
}

/** What Ctrl+C needs of Pyodide: the buffer its interpreter polls for signals, and a check of it now. */
export interface InterruptTarget {
  setInterruptBuffer(buffer: Int32Array): void;
  checkInterrupt(): void;
}

/** How often a sleep looks for a Ctrl+C: nobody notices 20 ms, and a sleeping worker does not either. */
export const SLEEP_POLL_MS = 20;

/**
 * A Ctrl+C that arrives while Python waits for JavaScript: a call of the `oxidevm` module or `time.sleep`. Pyodide polls
 * the interrupt buffer whenever Python code runs, its own event loop included, and that loop, which resumes Python when
 * a wait ends, cannot take a KeyboardInterrupt: one raised there escapes into JavaScript and the program never resumes.
 * So a wait takes a pending Ctrl+C out of the buffer before it ends (`hold`), and Python puts it back as soon as it runs
 * again (`restore`, then `pyodide.checkInterrupt`), which raises KeyboardInterrupt in the program.
 */
export interface Interrupts {
  /** The buffer of SIGINT's trap. Until then there is nothing to hold. */
  attach(buffer: Int32Array): void;
  /**
   * Makes Pyodide poll the buffer, and raises a Ctrl+C that is already waiting. The runner calls it from Python, inside
   * the `try` that turns every KeyboardInterrupt into an outcome, so that none escapes into Pyodide's event loop.
   */
  arm(py: InterruptTarget): void;
  hold(): void;
  /** Puts a held Ctrl+C back, unless a newer one is already waiting. */
  restore(): void;
  /** Waits for the time to pass, or until a Ctrl+C is pending, which it holds. */
  sleep(milliseconds: number): Promise<void>;
}

export function createInterrupts(): Interrupts {
  let buffer: Int32Array | undefined;
  let held = 0;
  const pending = (): boolean => buffer !== undefined && Atomics.load(buffer, 0) !== 0;
  const hold = (): void => {
    const signal = buffer === undefined ? 0 : Atomics.exchange(buffer, 0, 0);
    if (signal !== 0) held = signal;
  };
  return {
    attach(given) { buffer = given; },
    arm(py) {
      if (buffer === undefined) return;
      py.setInterruptBuffer(buffer);
      py.checkInterrupt();
    },
    hold,
    restore() {
      if (buffer !== undefined && held !== 0) Atomics.compareExchange(buffer, 0, 0, held);
      held = 0;
    },
    sleep: milliseconds => new Promise<void>(resolve => {
      const deadline = Date.now() + milliseconds;
      const tick = (): void => {
        const left = deadline - Date.now();
        if (pending() || left <= 0) { hold(); resolve(); return; }
        setTimeout(tick, Math.min(left, SLEEP_POLL_MS));
      };
      tick();
    }),
  };
}

/**
 * Lets Ctrl+C reach the program as KeyboardInterrupt: traps SIGINT and gives `interrupts` the trap's interrupt buffer,
 * into which the runtime writes the signal. Once armed, Pyodide polls the buffer while Python runs, and a host operation
 * that the signal interrupts fails with EINTR, after which Python checks the buffer, as CPython does after any
 * interrupted system call. Call it once Pyodide has loaded and just before the program runs: until then SIGINT keeps its
 * default action, so Ctrl+C while Pyodide loads ends the process at once.
 */
export async function catchInterrupts(signals: ProcessSignals, interrupts: Interrupts): Promise<SignalTrap> {
  const trap = await signals.trap(["SIGINT"]);
  interrupts.attach(trap.interruptBuffer);
  return trap;
}

/**
 * Ends the process the way CPython 3.8+ does after a program left a KeyboardInterrupt unhandled: SIGINT gets its default
 * action back and is raised, so that the process ends killed by SIGINT and a shell sees 130 and stops a loop. Raising it
 * does not return; if it ever did, the module stops with an error rather than pretend.
 */
export async function endBySignal(signals: ProcessSignals, trap: SignalTrap): Promise<never> {
  await trap.untrap();
  await signals.raise("SIGINT");
  throw new ModuleError("signal-raise", "Raising SIGINT with its default action did not end the process");
}
