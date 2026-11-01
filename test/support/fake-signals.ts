import type { ProcessSignals, SignalTrap, TrappableSignal } from "@oxidevm/sdk/wasm";

/** A stand-in for the `process.signals` capability, which the SDK's runner provides from engine ADR 0027. */
export interface FakeSignals {
  readonly signals: ProcessSignals;
  /** What the module asked for, in order: `trap SIGINT`, `untrap`, `raise SIGINT`. */
  readonly calls: string[];
  /** The interrupt buffer every trap hands out (Pyodide's format): a test writes 2 into [0] to deliver SIGINT. */
  readonly buffer: Int32Array;
  /** Settles when the module raises a signal. The raise itself never settles, as the process would be gone. */
  readonly raised: Promise<TrappableSignal>;
}

/** `pendingAtTrap`: a Ctrl+C arrives as soon as SIGINT is trapped, before the program has started. */
export function fakeSignals(calls: string[] = [], options: { readonly pendingAtTrap?: boolean } = {}): FakeSignals {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  let announce: (signal: TrappableSignal) => void = () => undefined;
  const raised = new Promise<TrappableSignal>(resolve => { announce = resolve; });
  const signals: ProcessSignals = {
    trap(list) {
      calls.push(`trap ${list.join(",")}`);
      if (options.pendingAtTrap === true) buffer[0] = 2;
      const trap: SignalTrap = {
        signals: [...list],
        interruptBuffer: buffer,
        untrap: () => { calls.push("untrap"); return Promise.resolve(); },
        // The module reads the interrupt buffer, not the iterator.
        [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }),
      };
      return Promise.resolve(trap);
    },
    raise(signal) {
      calls.push(`raise ${signal}`);
      announce(signal);
      return new Promise<void>(() => undefined);
    },
  };
  return { signals, calls, buffer, raised };
}
