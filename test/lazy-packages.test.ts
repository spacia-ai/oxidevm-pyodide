import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ShippedPackages } from "../src/guest.ts";
import { startGuest } from "./support/guest-fixture.ts";
import type { GuestFixture } from "./support/guest-fixture.ts";

// The import hook that loads a shipped package when a program imports it, with the real Pyodide in Node. The loader is
// a stand-in that "installs" a package by writing its module into site-packages, as installSync unpacks a wheel there; the real loading from the release's copies is tested in test/python-loader.test.ts and, against the
// real engine, in test/browser/.

const IMPORTS = new Map([["PIL", "pillow"], ["pylab", "matplotlib"], ["fakenumpy", "fakenumpy"], ["fakepandas", "fakepandas"], ["broken", "broken"]]);

let guest: GuestFixture;
const installs: string[][] = [];
let sitePackages = "";
/** What the next install does before it returns: by default nothing more than writing the package's modules. */
let onInstall: (names: readonly string[]) => void = () => undefined;

const packages: ShippedPackages = {
  imports: IMPORTS,
  loaded: new Set(["six"]),
  installSync: names => {
    installs.push([...names]);
    onInstall(names);
    for (const name of names) {
      if (name === "broken") throw new Error("the wheel of broken does not unpack");
      const modules = [...IMPORTS].filter(([, owner]) => owner === name).map(([module]) => module);
      for (const module of modules) guest.py.FS.writeFile(`${sitePackages}/${module}.py`, `print('loaded ${module}')\nNAME = '${name}'\n`);
    }
    return ["six", ...names];
  },
};

beforeAll(async () => {
  guest = await startGuest(undefined, { packages });
  const found: unknown = guest.py.runPython("import sysconfig\nsysconfig.get_path('purelib')");
  if (typeof found !== "string") throw new Error("no site-packages");
  sitePackages = found;
}, 120_000);

beforeEach(() => { installs.length = 0; onInstall = () => undefined; });

afterAll(async () => {
  await guest.stop();
  await guest.dispose();
});

describe("a shipped package, imported", () => {
  it("loads once, on the first import of one of its top-level modules, and imports as if it had been there", async () => {
    expect(await guest.run("import PIL\nimport PIL\nprint(PIL.NAME)\nfrom PIL import NAME\nprint(NAME)\n")).toEqual({ status: 0, stdout: "loaded PIL\npillow\npillow\n", stderr: "" });
    expect(installs).toEqual([["pillow"]]);
    expect(await guest.run("import PIL\nprint('again')\n")).toEqual({ status: 0, stdout: "again\n", stderr: "" });
    expect(installs).toEqual([["pillow"]]);
  });

  it("loads the package a module of another name belongs to, as pylab belongs to matplotlib", async () => {
    expect(await guest.run("import pylab\nprint(pylab.NAME)\n")).toMatchObject({ status: 0, stdout: "loaded pylab\nmatplotlib\n" });
    expect(installs).toEqual([["matplotlib"]]);
  });

  it("does not load anything for a package that was loaded before the program, a submodule, or a module no shipped package provides", async () => {
    expect(await guest.run("import json\ntry:\n    import six\nexcept ImportError as error:\n    print(type(error).__name__)\ntry:\n    import nosuchthing\nexcept ImportError as error:\n    print(type(error).__name__, error.name)\n")).toEqual({ status: 0, stdout: "ModuleNotFoundError\nModuleNotFoundError nosuchthing\n", stderr: "" });
    expect(installs).toEqual([]);
  });

  it("raises ImportError naming the package when it cannot be loaded, and tries again on the next import", async () => {
    const result = await guest.run("for attempt in range(2):\n    try:\n        import broken\n    except ImportError as error:\n        print(type(error).__name__, error.name, str(error).split(':')[0])\n");
    expect(result).toEqual({ status: 0, stdout: "ImportError broken cannot load the broken package for 'broken'\nImportError broken cannot load the broken package for 'broken'\n", stderr: "" });
    expect(installs).toEqual([["broken"], ["broken"]]);
  });

  it("loads a package where Python cannot wait for JavaScript too (no JSPI, or a callback from JavaScript)", () => {
    const seen: unknown = guest.py.runPython("from pyodide.ffi import can_run_sync\nimport fakenumpy\nstr((can_run_sync(), fakenumpy.NAME))");
    expect(seen).toBe("(False, 'fakenumpy')");
    expect(installs).toEqual([["fakenumpy"]]);
  });

  it("raises a Ctrl+C that arrived while the package loaded once the load ends, as after any wait", async () => {
    onInstall = () => { guest.interrupts[0] = 2; };
    const result = await guest.run("import fakepandas\nprint('not reached')\n");
    expect(result).toMatchObject({ status: "SIGINT", stdout: "" });
    expect(result.stderr).toMatch(/line 1, in <module>[\s\S]*KeyboardInterrupt\n$/u);
  });
});
