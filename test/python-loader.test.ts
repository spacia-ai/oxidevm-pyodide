import { describe, expect, it } from "vitest";
import { VIRTUAL_INDEX } from "../src/artifact-fetch.ts";
import type { Fetch } from "../src/artifact-fetch.ts";
import { ModuleError } from "../src/errors.ts";
import { loadPython } from "../src/python-loader.ts";
import type { Engine, LoadRequest, PackageLoader, PyodideOptions } from "../src/python-loader.ts";
import { WHEELS } from "../src/shipped.ts";
import type { ShippedFile } from "../src/shipped.ts";

const LOCK = JSON.stringify({
  packages: {
    pandas: { file_name: WHEELS.pandas, depends: ["numpy", "python-dateutil"] },
    numpy: { file_name: WHEELS.numpy, depends: [] },
    "python-dateutil": { file_name: WHEELS["python-dateutil"], depends: ["six"] },
    six: { file_name: WHEELS.six, depends: [] },
    pytz: { file_name: WHEELS.pytz },
    scipy: { file_name: "scipy-1.16.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl", depends: ["numpy"] },
    ghost: { file_name: "ghost-1.0-py3-none-any.whl", depends: [] },
  },
});

interface Fixture {
  readonly request: LoadRequest;
  readonly engine: Engine<PackageLoader>;
  readonly asked: ShippedFile[];
  readonly events: string[];
  readonly options: PyodideOptions[];
  readonly loaded: string[][];
  readonly logs: string[];
  readonly scope: { fetch: Fetch };
  readonly network: string[];
}

function fixture(packages: readonly string[], overrides: { readonly bytes?: LoadRequest["bytes"]; readonly lock?: string; readonly during?: (scope: { fetch: Fetch }) => Promise<void>; readonly failLoad?: Error; readonly failPackages?: Error } = {}): Fixture {
  const asked: ShippedFile[] = [], events: string[] = [], options: PyodideOptions[] = [], loaded: string[][] = [], logs: string[] = [], network: string[] = [];
  const scope: { fetch: Fetch } = { fetch: (input) => { network.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url); return Promise.resolve(new Response("network")); } };
  const request: LoadRequest = {
    packages, env: { HOME: "/workspace", FOO: "bar" }, log: line => { logs.push(line); },
    bytes: overrides.bytes ?? ((name: ShippedFile) => { asked.push(name); events.push(`bytes ${name}`); return Promise.resolve(name === "pyodide-lock.json" ? new TextEncoder().encode(overrides.lock ?? LOCK) : new TextEncoder().encode(`content of ${name}`)); }),
  };
  const engine = {
    scope,
    createPyodideModule: () => Promise.reject(new Error("the factory is only handed over, never called, by the loader")),
    async loadPyodide(given: PyodideOptions) {
      events.push("loadPyodide");
      options.push(given);
      await overrides.during?.(scope);
      if (overrides.failLoad !== undefined) throw overrides.failLoad;
      return {
        loadPackage: (names: string[]) => {
          events.push("loadPackage");
          loaded.push(names);
          return overrides.failPackages === undefined ? Promise.resolve([]) : Promise.reject(overrides.failPackages);
        },
      };
    },
  };
  return { request, engine: { ...engine, createPyodideModule: engine.createPyodideModule }, asked, events, options, loaded, logs, scope, network };
}

async function failure(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected a failure");
}

describe("loadPython", () => {
  it("reads the lock, the runtime and the wheels of the requested packages and what they need, each once, and no others", async () => {
    const f = fixture(["pandas"]);
    await loadPython(f.request, f.engine);
    expect([...f.asked].sort()).toEqual(["pyodide-lock.json", "pyodide.asm.wasm", "python_stdlib.zip", WHEELS.numpy, WHEELS.pandas, WHEELS["python-dateutil"], WHEELS.six].sort());
    expect(new Set(f.asked).size).toBe(f.asked.length);
  });

  it("verifies everything before Pyodide starts, so that a bad file stops the module before any Python runs", async () => {
    const f = fixture(["numpy"]);
    await loadPython(f.request, f.engine);
    const started = f.events.indexOf("loadPyodide");
    expect(f.events.slice(0, started).every(event => event.startsWith("bytes "))).toBe(true);
    expect(f.events.slice(0, started)).toHaveLength(4);
    expect(f.events.slice(started)).toEqual(["loadPyodide", "loadPackage"]);
  });

  it("hands Pyodide a virtual index, the lock text and the bundled factory, and the process environment", async () => {
    const f = fixture(["six"]);
    await loadPython(f.request, f.engine);
    expect(f.options).toHaveLength(1);
    const [given] = f.options;
    expect(given).toMatchObject({ indexURL: VIRTUAL_INDEX, packageBaseUrl: VIRTUAL_INDEX, lockFileContents: LOCK, env: { HOME: "/workspace", FOO: "bar" } });
    expect(given?.createPyodideModule).toBe(f.engine.createPyodideModule);
    expect(given?.env).not.toBe(f.request.env);
  });

  it("loads the packages that were asked for by name, and lets Pyodide resolve what they need", async () => {
    const f = fixture(["pandas", "pytz"]);
    await loadPython(f.request, f.engine);
    expect(f.loaded).toEqual([["pandas", "pytz"]]);
  });

  it("does not ask Pyodide to load packages when none were asked for", async () => {
    const f = fixture([]);
    await loadPython(f.request, f.engine);
    expect(f.loaded).toEqual([]);
    expect([...f.asked].sort()).toEqual(["pyodide-lock.json", "pyodide.asm.wasm", "python_stdlib.zip"]);
  });

  it("serves the verified files at the virtual index while Pyodide loads, and restores fetch afterwards", async () => {
    const seen: string[] = [];
    const f = fixture(["six"], { during: async scope => {
      const wasm = await scope.fetch(`${VIRTUAL_INDEX}pyodide.asm.wasm`);
      seen.push(await wasm.text(), wasm.headers.get("content-type") ?? "");
      const wheel = await scope.fetch(`${VIRTUAL_INDEX}${WHEELS.six}`);
      seen.push(await wheel.text());
      // A wheel that was not requested is not served, and the virtual host is never reached for real.
      seen.push(await scope.fetch(`${VIRTUAL_INDEX}${WHEELS.numpy}`).then(() => "served", () => "refused"));
      seen.push(await (await scope.fetch("https://example.com/other")).text());
    } });
    const before = f.scope.fetch;
    await loadPython(f.request, f.engine);
    expect(seen).toEqual(["content of pyodide.asm.wasm", "application/wasm", `content of ${WHEELS.six}`, "refused", "network"]);
    expect(f.scope.fetch).toBe(before);
    expect(f.network).toEqual(["https://example.com/other"]);
  });

  it("restores fetch when Pyodide fails to start or to load a package, and passes the failure on unchanged", async () => {
    const startFailure = new Error("start failed"), packageFailure = new Error("package failed");
    const starting = fixture(["six"], { failLoad: startFailure });
    const before = starting.scope.fetch;
    expect(await failure(loadPython(starting.request, starting.engine))).toBe(startFailure);
    expect(starting.scope.fetch).toBe(before);
    const packaging = fixture(["six"], { failPackages: packageFailure });
    const beforePackaging = packaging.scope.fetch;
    expect(await failure(loadPython(packaging.request, packaging.engine))).toBe(packageFailure);
    expect(packaging.scope.fetch).toBe(beforePackaging);
  });

  it("forwards what Pyodide reports as errors, and keeps its start-up output out of the way", async () => {
    const f = fixture(["six"]);
    await loadPython(f.request, f.engine);
    const [given] = f.options;
    given?.stdout?.("startup chatter");
    given?.stderr?.("a real error");
    expect(f.logs).toEqual(["a real error"]);
  });

  it("stops with the integrity failure itself, before Pyodide exists, when a file does not match its pin", async () => {
    const tampered = new Error("python_stdlib.zip does not match its sha256 pin");
    const asked: string[] = [];
    const f = fixture(["six"], { bytes: name => {
      asked.push(name);
      return name === "python_stdlib.zip" ? Promise.reject(tampered) : Promise.resolve(name === "pyodide-lock.json" ? new TextEncoder().encode(LOCK) : new Uint8Array(1));
    } });
    const before = f.scope.fetch;
    expect(await failure(loadPython(f.request, f.engine))).toBe(tampered);
    expect(f.options).toEqual([]);
    expect(f.scope.fetch).toBe(before);
    expect(asked).toContain("python_stdlib.zip");
  });

  it("stops at once when the lock itself does not match its pin", async () => {
    const tampered = new Error("lock tampered");
    const f = fixture(["six"], { bytes: name => (name === "pyodide-lock.json" ? Promise.reject(tampered) : Promise.resolve(new Uint8Array(1))) });
    expect(await failure(loadPython(f.request, f.engine))).toBe(tampered);
    expect(f.options).toEqual([]);
  });

  it("names a package the lock does not know", async () => {
    const f = fixture(["nonexistent"]);
    const error = await failure(loadPython(f.request, f.engine));
    expect(error).toBeInstanceOf(ModuleError);
    expect(error instanceof ModuleError ? [error.code, error.message] : []).toEqual(["package-unknown", "The Pyodide lock has no package nonexistent"]);
    expect(f.options).toEqual([]);
  });

  it("names a package whose wheel the release does not carry, including one that a carried package needs", async () => {
    for (const requested of ["scipy", "ghost"]) {
      const f = fixture([requested]);
      const error = await failure(loadPython(f.request, f.engine));
      expect(error, requested).toBeInstanceOf(ModuleError);
      expect(error instanceof ModuleError ? error.code : "", requested).toBe("package-not-shipped");
      expect(f.options).toEqual([]);
    }
    const needing = fixture(["pandas"], { lock: LOCK.replace('"file_name":"numpy-', '"file_name":"changed-numpy-') });
    expect(await failure(loadPython(needing.request, needing.engine))).toBeInstanceOf(ModuleError);
  });
});
