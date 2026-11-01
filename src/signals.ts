import type { ProcessSignals, SignalTrap } from "@oxidevm/sdk/wasm";
import { ModuleError } from "./errors.ts";

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
