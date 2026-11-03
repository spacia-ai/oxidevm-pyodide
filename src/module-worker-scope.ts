/**
 * Evaluated before Pyodide's modules (module.ts imports it first). Pyodide tells a classic worker from a module worker by
 * calling `importScripts("data:text/javascript,")` while its modules load; a module worker throws. The module's runner
 * offers `importScripts` only to report a module that tries to load code or data from elsewhere (engine ADR 0029, N-3),
 * so Pyodide's probe would print a network-direct warning on the program's standard error at every start. This makes
 * `importScripts` throw as it does in a module worker, before anything is loaded, so the probe gets its answer and nothing
 * is attempted.
 */
const moduleWorkerImportScripts = (): never => {
  throw new TypeError("importScripts is not available in a module worker");
};

if (typeof Reflect.get(globalThis, "importScripts") === "function") {
  Object.defineProperty(globalThis, "importScripts", { value: moduleWorkerImportScripts, configurable: true, writable: true });
}

export {};
