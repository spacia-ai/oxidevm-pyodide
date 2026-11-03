import { describe, expect, it } from "vitest";

describe("the module worker scope", () => {
  it("makes importScripts throw as in a module worker, so Pyodide's classic-worker probe loads nothing and warns nothing", async () => {
    const tried: string[] = [];
    Object.defineProperty(globalThis, "importScripts", { value: (url: string) => { tried.push(url); }, configurable: true, writable: true });
    try {
      await import("../src/module-worker-scope.ts");
      const probe: unknown = Reflect.get(globalThis, "importScripts");
      expect(typeof probe).toBe("function");
      expect(() => { if (typeof probe === "function") Reflect.apply(probe, globalThis, ["data:text/javascript,"]); }).toThrow(TypeError);
      expect(tried).toEqual([]);
    } finally {
      Reflect.deleteProperty(globalThis, "importScripts");
    }
  });
});
