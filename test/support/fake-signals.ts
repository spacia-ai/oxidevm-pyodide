import type { ProcessSignals, SignalName, SignalTrap, TrapSignal } from "@oxidevm/sdk/wasm";

/** A stand-in for the `process.signals` capability, which the SDK's runner provides from engine ADR 0027. */
export interface FakeSignals {
  readonly signals: ProcessSignals;
  /** What the module asked for, in order: `trap SIGINT`, `untrap`, `raise SIGINT`. */
  readonly calls: string[];
  /** The interrupt buffer every trap hands out (Pyodide's format): a test writes 2 into [0] to deliver SIGINT. */
  readonly buffer: Int32Array;
  /** Settles when the module raises a signal. The raise itself never settles, as the process would be gone. */
  readonly raised: Promise<TrapSignal>;
}

/** `pendingAtTrap`: a Ctrl+C arrives as soon as SIGINT is trapped, before the program has started. */
export function fakeSignals(calls: string[] = [], options: { readonly pendingAtTrap?: boolean } = {}): FakeSignals {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  let announce: (signal: TrapSignal) => void = () => undefined;
  const raised = new Promise<TrapSignal>(resolve => { announce = resolve; });
  const signals: ProcessSignals = {
    trap(list) {
      calls.push(`trap ${list.join(",")}`);
      if (options.pendingAtTrap === true) buffer[0] = 2;
      // The module reads the interrupt buffer, never the list of trapped signals, so the fake lists none.
      const trap: SignalTrap<never> = {
        signals: [],
        interruptBuffer: buffer,
        untrap: () => { calls.push("untrap"); return Promise.resolve(); },
        // The module reads the interrupt buffer, not the iterator.
        [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }),
      };
      return Promise.resolve(trap);
    },
    raise(signal) {
      calls.push(`raise ${String(signal)}`);
      announce(signal);
      return new Promise<void>(() => undefined);
    },
    block(list) { calls.push(`block ${list.map(String).join(",")}`); return Promise.resolve(new Set<SignalName>()); },
    unblock(list) { calls.push(`unblock ${list.map(String).join(",")}`); return Promise.resolve(new Set<SignalName>()); },
    pending() { return Promise.resolve(new Set<SignalName>()); },
  };
  return { signals, calls, buffer, raised };
}
