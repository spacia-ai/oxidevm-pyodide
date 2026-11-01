import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyLicense, COMMANDS_MIN_API, decodeDeclaration, manifestMinApi } from "@oxidevm/sdk/wasm";
import { describe, expect, it } from "vitest";
import { RECORDED } from "../scripts/notices.ts";
import { decodeUpstreamLock } from "../scripts/upstream-lock.ts";
import definition from "../module.ts";
import { field } from "./support/decode.ts";
import { decodeLockfile, wheelsFor } from "../src/lock.ts";
import { COMMANDS, NOTICE_FILES, PACKAGE_NAMES, RUNTIME_FILES, WHEELS } from "../src/shipped.ts";

// The manifest in module.ts must be a literal (the build reads it without running code), so the files and packages it names
// are written out there and again in src/shipped.ts and upstream/lock.json. These tests are what keeps the copies equal.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = definition.manifest;
const lock = decodeUpstreamLock(await readFile(join(root, "upstream/lock.json"), "utf8"));
const pyodideLock = decodeLockfile(await readFile(join(root, "upstream/pyodide-lock.json"), "utf8"));

describe("the manifest", () => {
  it("is what the SDK's own declaration decoder accepts", () => {
    expect(() => decodeDeclaration(manifest)).not.toThrow();
  });

  it("declares python3 and python as commands on the VM's PATH, the names src/shipped.ts gives them", () => {
    expect(manifest.commands).toEqual(["python", "python3"]);
    expect([...manifest.commands]).toEqual([...COMMANDS]);
    expect([...COMMANDS]).toEqual([...COMMANDS].sort());
    expect(manifest.version).toBe("0.2.0");
  });

  it("needs the engine that runs module commands and delivers process.signals (Userspace API 145)", () => {
    expect(manifest.requires.host).toContain("process.signals");
    expect(manifestMinApi(manifest)).toBe(145);
    expect(COMMANDS_MIN_API).toBe(145);
  });

  it("declares a command module for the Emscripten ABI with the host operations the adapter uses", () => {
    expect(manifest.id).toBe("pyodide");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(manifest.abi).toBe("emscripten");
    expect(manifest.process).toEqual({ kind: "command" });
    expect([...manifest.requires.host].sort()).toEqual(["files.async", "files.sync", "process.info", "process.signals", "process.spawn", "sockets.connect"]);
    expect([...manifest.requires.browser].sort()).toEqual(["cross-origin-isolated", "jspi"]);
  });

  it("lists exactly the artifacts that src/shipped.ts and upstream/lock.json name, each from where it is mirrored or written", () => {
    const names = manifest.artifacts.map(artifact => artifact.name);
    expect([...names].sort()).toEqual([...RUNTIME_FILES, ...Object.values(WHEELS), ...NOTICE_FILES].sort());
    expect([...names.filter(name => !(NOTICE_FILES as readonly string[]).includes(name))].sort()).toEqual(lock.files.map(file => file.name).sort());
    for (const artifact of manifest.artifacts) expect(artifact.from).toBe((NOTICE_FILES as readonly string[]).includes(artifact.name) ? artifact.name : `upstream/${artifact.name}`);
  });

  it("offers as packages exactly the wheels it carries, and loads pandas and matplotlib by default", () => {
    const option = manifest.options.packages;
    expect([...option.values]).toEqual(PACKAGE_NAMES);
    expect([...option.values].sort()).toEqual(lock.files.flatMap(file => (file.role === "wheel" ? [file.package] : [])).sort());
    expect(option.default).toEqual(["pandas", "matplotlib"]);
    for (const [name, file] of Object.entries(WHEELS)) expect(lock.files.find(item => item.role === "wheel" && item.package === name)?.name, name).toBe(file);
  });

  it("carries, for every package it offers, everything Pyodide's own lock says that package needs", () => {
    const shipped = new Set<string>(Object.values(WHEELS));
    for (const name of manifest.options.packages.values) {
      const closure = wheelsFor(pyodideLock, [name]);
      expect(closure.filter(item => !shipped.has(item.fileName)).map(item => item.name), `what ${name} needs`).toEqual([]);
    }
    expect(wheelsFor(pyodideLock, manifest.options.packages.default).map(item => item.fileName).sort()).toEqual(Object.values(WHEELS).sort());
  });

  it("pins each wheel to the file name, version and sha256 that Pyodide's own lock gives it", async () => {
    const raw: unknown = JSON.parse(await readFile(join(root, "upstream/pyodide-lock.json"), "utf8"));
    const packages = field(raw, "packages");
    for (const file of lock.files) {
      if (file.role !== "wheel") continue;
      const entry = field(packages, file.package);
      expect({ file_name: field(entry, "file_name"), version: field(entry, "version"), sha256: field(entry, "sha256") }, file.package).toEqual({ file_name: file.name, version: file.version, sha256: file.sha256 });
    }
  });

  it("states the licence of what ships, with the source of the copyleft part and a notices artifact", () => {
    const { license } = manifest;
    expect(classifyLicense(license.spdx).copyleft).toBe(true);
    expect(license.source).toMatch(/^https:\/\/github\.com\/pyodide\/pyodide\/tree\/[0-9a-f]{40}$/u);
    expect(license.source).toContain(lock.pyodide.source.commit);
    expect(license.notices).toEqual([...NOTICE_FILES]);
  });

  it("records the origin of every upstream component, and it is the one the lock and the notices name", () => {
    const [runtime, ...packages] = manifest.upstream;
    expect(runtime).toEqual({ name: "Pyodide", version: lock.pyodide.version, source: `https://github.com/pyodide/pyodide/tree/${lock.pyodide.source.commit}` });
    const wheels = lock.files.flatMap(file => (file.role === "wheel" ? [file] : []));
    expect(packages.map(item => [item.name, item.version]).sort()).toEqual(wheels.map(file => [file.package, file.version]).sort());
    for (const item of packages) expect(item.source, item.name).toBe(RECORDED[item.name]?.source);
  });
});
