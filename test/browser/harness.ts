// The real-engine test of the module, in Chromium. It does what an application developer does, then runs the result:
//   1. builds the module (`oxidevm wasm build`) unless --no-build;
//   2. installs the release into a fresh project with the real CLI (`oxidevm wasm add file:… --yes`), which stages the
//      files and generates the typed handle, and checks that `oxidevm wasm doctor` passes;
//   3. type-checks the page's code against that handle with strict compiler flags;
//   4. builds the page with Vite, serves it with the SDK's pinned engine release and a signed Userspace image that has
//      python3 (pandas and matplotlib are not needed natively), and drives Chromium through the scenarios.
//
//   pnpm run build   # or let the harness build
//   OXIDEVM_TEST_USERSPACE_IMAGE=<image reference JSON> OXIDEVM_TEST_USERSPACE_IMAGE_DIR=<bundle dist> pnpm run test:browser
//
// Optional: OXIDEVM_ENGINE_DIR, OXIDEVM_ENGINE_COMPLIANCE_DIR (default: ~/.cache/oxidevm/engine/...), OXIDEVM_VERBOSE=1
// (page console output), --only <text> (run the scenarios whose name contains it), --keep (keep the scratch directory),
// --no-build (use the existing dist/). The results go to .cache/test-results/pyodide-browser.json, and the server's log
// (every path requested, in order) to pyodide-browser-requests.txt beside it.
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { decodeProjectConfig, getSDKRelease, pinnedEngineCompliance } from "@oxidevm/sdk/image-builder";
import { chromium } from "playwright-core";
import { build } from "vite";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const pageSources = join(root, "test/browser/page");

export interface Scenario {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

interface Inputs {
  readonly imageReference: unknown;
  readonly imageDir: string;
  readonly engineDir: string;
  readonly complianceDir: string | undefined;
}

/** Finds the engine release, its compliance files and the signed image, and says what is missing. */
async function locateInputs(environment: NodeJS.ProcessEnv): Promise<Inputs> {
  const imageFile = environment["OXIDEVM_TEST_USERSPACE_IMAGE"], imageDir = environment["OXIDEVM_TEST_USERSPACE_IMAGE_DIR"];
  if (imageFile === undefined || imageDir === undefined) {
    throw new Error("Set OXIDEVM_TEST_USERSPACE_IMAGE (an image reference JSON) and OXIDEVM_TEST_USERSPACE_IMAGE_DIR (its bundle directory).");
  }
  const engineId = getSDKRelease().engineRelease.replace(/^sha256:/u, "");
  const engineDir = environment["OXIDEVM_ENGINE_DIR"] ?? join(homedir(), ".cache/oxidevm/engine", engineId);
  const compliance = pinnedEngineCompliance();
  const complianceDir = compliance === null ? undefined : environment["OXIDEVM_ENGINE_COMPLIANCE_DIR"] ?? join(homedir(), ".cache/oxidevm/engine/compliance", compliance.sha256);
  for (const path of [imageFile, imageDir, engineDir, ...(complianceDir === undefined ? [] : [complianceDir])]) await stat(path);
  const imageReference: unknown = JSON.parse(await readFile(imageFile, "utf8"));
  return { imageReference, imageDir, engineDir, complianceDir };
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".wasm": "application/wasm", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".html": "text/html", ".css": "text/css", ".png": "image/png",
};

interface Served {
  readonly origin: string;
  /** The server's log: every path requested, in order, except the test's own `/__` switches. */
  readonly requests: readonly string[];
  readonly close: () => Promise<void>;
}

/**
 * Serves the page, the engine and the image with the headers cross-origin isolation needs. Nothing is cached, so a change
 * of the tamper switch takes effect on the next request, and every file a run needs is requested again. While the switch
 * is on, the module's `python_stdlib` file is served with one byte changed, as a compromised host would serve it.
 * `/__requests?since=<n>` answers with the server's log from entry n on (`{ next, paths }`), so that a scenario can check
 * what was fetched while it ran.
 */
const MODULE_FRAME_PATH = "/engine/module-frame/";
const MODULE_FRAME_DIR = join(root, "node_modules/@oxidevm/sdk/assets/module-frame");

/** The module frame's response headers, from the SDK's `frame.json`. */
async function moduleFrameHeaders(): Promise<Readonly<Record<string, string>>> {
  const frame: unknown = JSON.parse(await readFile(join(MODULE_FRAME_DIR, "frame.json"), "utf8"));
  const headers: unknown = typeof frame === "object" && frame !== null ? Reflect.get(frame, "headers") : undefined;
  if (typeof headers !== "object" || headers === null) throw new Error("The SDK's module-frame/frame.json has no headers");
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, String(value)]));
}

async function serve(locations: { readonly inputs: Inputs; readonly page: string; readonly imagePrefix: string; readonly frameHeaders: Readonly<Record<string, string>> }): Promise<Served> {
  let tamper = false;
  const requests: string[] = [];
  const { inputs, page, imagePrefix } = locations;
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost"), path = url.pathname;
    // Engine ADR 0028: module code runs in the SDK's module frame beside the engine, served with the frame's own headers.
    if (path.startsWith(MODULE_FRAME_PATH)) {
      requests.push(path);
      const name = path.slice(MODULE_FRAME_PATH.length) || "index.html";
      if (!["index.html", "broker.js", "runner.js"].includes(name)) { response.writeHead(404); response.end(); return; }
      for (const [header, value] of Object.entries(locations.frameHeaders)) response.setHeader(header, value);
      response.setHeader("Content-Type", name.endsWith(".html") ? "text/html" : "text/javascript");
      createReadStream(join(MODULE_FRAME_DIR, name)).pipe(response);
      return;
    }
    for (const [name, value] of [["Cross-Origin-Opener-Policy", "same-origin"], ["Cross-Origin-Embedder-Policy", "require-corp"], ["Cross-Origin-Resource-Policy", "same-origin"], ["Cache-Control", "no-store"]] as const) response.setHeader(name, value);
    if (path === "/__tamper/on" || path === "/__tamper/off") {
      tamper = path.endsWith("on");
      response.end(tamper ? "on" : "off");
      return;
    }
    if (path === "/__requests") {
      const since = Number(url.searchParams.get("since") ?? "0");
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ next: requests.length, paths: requests.slice(Number.isSafeInteger(since) && since > 0 ? since : 0) }));
      return;
    }
    requests.push(path);
    const complianceRoot = "/engine/compliance/";
    const file = path.startsWith(complianceRoot) && inputs.complianceDir !== undefined ? join(inputs.complianceDir, path.slice(complianceRoot.length + 65))
      : path.startsWith("/engine/") ? join(inputs.engineDir, path.slice("/engine/".length))
      : path.startsWith(imagePrefix) ? join(inputs.imageDir, path.slice(imagePrefix.length))
      : path.startsWith("/page/") ? join(page, path.slice("/page/".length) === "" ? "index.html" : path.slice("/page/".length)) : undefined;
    response.setHeader("Content-Type", CONTENT_TYPES[extname(path)] ?? "application/octet-stream");
    if (file === undefined) { response.writeHead(404); response.end(); return; }
    if (tamper && /\/python_stdlib[^/]*\.zip$/u.test(path)) {
      void readFile(file).then(bytes => {
        const changed = Uint8Array.from(bytes);
        changed[100] = (changed[100] ?? 0) ^ 1;
        response.end(changed);
      }, () => { response.writeHead(404); response.end(); });
      return;
    }
    const stream = createReadStream(file);
    stream.on("error", () => { process.stderr.write(`404: ${path}\n`); response.writeHead(404); response.end(); });
    stream.pipe(response);
  });
  await new Promise<void>(ready => { server.listen(0, "127.0.0.1", ready); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the test server has no port");
  return { origin: `http://127.0.0.1:${String(address.port)}`, requests, close: () => new Promise<void>(done => { server.close(() => { done(); }); }) };
}

async function cli(project: string, ...args: readonly string[]): Promise<string> {
  const { stdout } = await execute(process.execPath, [join(root, "node_modules/@oxidevm/cli/dist/bin.js"), ...args], { cwd: project, maxBuffer: 16 * 1024 ** 2 });
  return stdout;
}

/** Builds a project the way an application does: the SDK, the page, and the module installed from its release. */
async function createProject(scratch: string): Promise<string> {
  const project = join(scratch, "project");
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(join(project, "node_modules/@oxidevm"), { recursive: true });
  await symlink(await realpath(join(root, "node_modules/@oxidevm/sdk")), join(project, "node_modules/@oxidevm/sdk"));
  await writeFile(join(project, "package.json"), `${JSON.stringify({ name: "pyodide-module-qualification", private: true, type: "module" }, null, 2)}\n`);
  await copyFile(join(pageSources, "index.html"), join(project, "index.html"));
  await copyFile(join(pageSources, "tsconfig.json.template"), join(project, "tsconfig.json"));
  await copyFile(join(pageSources, "main.ts.template"), join(project, "src/main.ts"));
  for (const name of await readdir(pageSources)) if (name.endsWith(".ts")) await copyFile(join(pageSources, name), join(project, "src", name));
  await cp(join(root, "dist"), join(project, "releases/pyodide"), { recursive: true });
  const added = await cli(project, "wasm", "add", "file:releases/pyodide", "--yes", "--project", project, "--json");
  if (!added.includes('"kind":"result"')) throw new Error(`wasm add: ${added}`);
  const doctor = await cli(project, "wasm", "doctor", "--project", project, "--json");
  if (!doctor.includes('"result":"passed"')) throw new Error(`wasm doctor should pass on a freshly installed project: ${doctor}`);
  return project;
}

async function typecheck(project: string): Promise<void> {
  await execute(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(project, "tsconfig.json")], { cwd: project, maxBuffer: 16 * 1024 ** 2 }).catch((error: unknown) => {
    const output = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);
    throw new Error(`the page's code does not type-check against the generated handle:\n${output}`, { cause: error });
  });
}

function decodeResults(value: unknown): readonly Scenario[] {
  if (!Array.isArray(value)) throw new Error("The page returned no scenario results");
  return Array.from<unknown>(value).map(entry => {
    const name: unknown = typeof entry === "object" && entry !== null ? Reflect.get(entry, "name") : undefined;
    const ok: unknown = typeof entry === "object" && entry !== null ? Reflect.get(entry, "ok") : undefined;
    const detail: unknown = typeof entry === "object" && entry !== null ? Reflect.get(entry, "detail") : undefined;
    if (typeof name !== "string" || typeof ok !== "boolean" || typeof detail !== "string") throw new Error("A scenario result has the wrong fields");
    return { name, ok, detail };
  });
}

function show(result: Scenario): void {
  process.stdout.write(`${result.ok ? "PASS" : "FAIL"}  ${result.name}\n      ${result.detail.split("\n").join("\n      ")}\n`);
}

export interface Options {
  readonly only?: string;
  readonly keep: boolean;
  readonly build: boolean;
}

/** Runs the whole pipeline and returns the scenario results. The scratch directory is removed unless `keep` is set. */
export async function runBrowserTest(options: Options): Promise<{ readonly results: readonly Scenario[]; readonly browser: string; readonly requests: readonly string[] }> {
  const inputs = await locateInputs(process.env);
  if (options.build) await cli(root, "wasm", "build");
  await stat(join(root, "dist/module.json"));
  const reference = decodeProjectConfig({ mode: "userspace", image: inputs.imageReference }).image;
  if (reference === undefined) throw new Error("The image reference JSON is not a signed image reference");
  await mkdir(join(root, ".cache"), { recursive: true });
  const scratch = await mkdtemp(join(root, ".cache/browser-"));
  let served: Served | undefined;
  try {
    const project = await createProject(scratch);
    await typecheck(project);
    const page = join(scratch, "page");
    await build({ root: project, configFile: false, logLevel: "warn", base: "/page/", build: { outDir: page, emptyOutDir: true, target: "esnext", assetsInlineLimit: 0, chunkSizeWarningLimit: 4096 }, worker: { format: "es" } });
    const imagePrefix = `${dirname(new URL(reference.manifestUrl, "http://x").pathname)}/`;
    served = await serve({ inputs, page, imagePrefix, frameHeaders: await moduleFrameHeaders() });
    const image = { manifestUrl: new URL(reference.manifestUrl, served.origin).href, manifestSHA256: reference.manifestSHA256, trust: reference.trust };
    const browser = await chromium.launch({ headless: true, args: ["--js-flags=--experimental-wasm-return-call"] });
    try {
      const tab = await browser.newPage();
      tab.setDefaultTimeout(0);
      tab.on("console", message => { if (process.env["OXIDEVM_VERBOSE"] !== undefined) process.stderr.write(`browser: ${message.text()}\n`); });
      tab.on("pageerror", error => { process.stderr.write(`page error: ${error.message}\n`); });
      await tab.exposeFunction("oxidevmReport", (value: unknown) => { decodeResults([value]).forEach(show); });
      await tab.goto(`${served.origin}/page/index.html`);
      const value: unknown = await tab.evaluate(async (input: { origin: string; image: typeof image; only?: string }) => {
        const run: unknown = Reflect.get(window, "runModuleScenarios");
        if (typeof run !== "function") throw new Error("The page did not register runModuleScenarios");
        const outcome: unknown = await Reflect.apply(run, undefined, [input]);
        return outcome;
      }, { origin: served.origin, image, ...(options.only === undefined ? {} : { only: options.only }) });
      return { results: decodeResults(value), browser: `chromium ${browser.version()}`, requests: served.requests };
    } finally {
      await browser.close();
    }
  } finally {
    await served?.close();
    if (!options.keep) await rm(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { only: { type: "string" }, keep: { type: "boolean" }, "no-build": { type: "boolean" } }, strict: true });
  try {
    const { results, browser, requests } = await runBrowserTest({ keep: values.keep === true, build: values["no-build"] !== true, ...(values.only === undefined ? {} : { only: values.only }) });
    const failed = results.filter(result => !result.ok).length;
    await mkdir(join(root, ".cache/test-results"), { recursive: true });
    await writeFile(join(root, ".cache/test-results/pyodide-browser.json"), `${JSON.stringify({ browser, results }, null, 2)}\n`);
    await writeFile(join(root, ".cache/test-results/pyodide-browser-requests.txt"), `${requests.join("\n")}\n`);
    process.stdout.write(`\n${String(results.length - failed)} of ${String(results.length)} scenarios passed (${browser})\n`);
    process.exitCode = failed === 0 && results.length > 0 ? 0 : 1;
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
