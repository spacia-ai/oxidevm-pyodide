import { isRecord } from "../src/records.ts";

/** One upstream file: where it comes from and exactly what it must contain. */
export interface PinnedFile {
  readonly name: string;
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** A file of the Pyodide runtime itself, from the `pyodide` npm package. */
export interface RuntimeFile extends PinnedFile {
  readonly role: "runtime";
}

/** A wheel of a Python package, from the Pyodide CDN. */
export interface WheelFile extends PinnedFile {
  readonly role: "wheel";
  /** The package's name in Pyodide's lock file. */
  readonly package: string;
  readonly version: string;
}

export type UpstreamFile = RuntimeFile | WheelFile;

/** `upstream/lock.json`: every file the release carries from upstream, with the provenance of the runtime. */
export interface UpstreamLock {
  readonly pyodide: {
    readonly version: string;
    readonly npm: { readonly package: string; readonly version: string; readonly tarball: string; readonly integrity: string };
    readonly source: { readonly repository: string; readonly tag: string; readonly commit: string };
  };
  readonly files: readonly UpstreamFile[];
}

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const MAX_FILE_BYTES = 512 * 1024 ** 2;

function fail(path: string, problem: string): never {
  throw new Error(`upstream/lock.json: ${path} ${problem}`);
}

function object(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return fail(path, "must be an object");
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) fail(path, `has an unknown field ${key}`);
  for (const key of required) if (!(key in value)) fail(path, `is missing ${key}`);
  return value;
}

function text(value: unknown, path: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value === "" || (pattern !== undefined && !pattern.test(value))) return fail(path, "has an invalid value");
  return value;
}

function https(value: unknown, path: string): string {
  const url = text(value, path);
  try {
    if (new URL(url).protocol === "https:") return url;
  } catch { /* reported below */ }
  return fail(path, "must be an https URL");
}

function decodeFile(value: unknown, index: number): UpstreamFile {
  const path = `files[${String(index)}]`;
  const role = isRecord(value) ? value["role"] : undefined;
  const common = (item: Readonly<Record<string, unknown>>): PinnedFile => {
    const bytes = item["bytes"];
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_FILE_BYTES) fail(`${path}.bytes`, "must be a positive size within the limit");
    return { name: text(item["name"], `${path}.name`, FILE_NAME), url: https(item["url"], `${path}.url`), sha256: text(item["sha256"], `${path}.sha256`, SHA256), bytes };
  };
  if (role === "runtime") return { role, ...common(object(value, path, ["name", "role", "url", "sha256", "bytes"])) };
  if (role === "wheel") {
    const item = object(value, path, ["name", "role", "url", "sha256", "bytes", "package", "version"]);
    return { role, ...common(item), package: text(item["package"], `${path}.package`, /^[a-z0-9][a-z0-9-]*$/u), version: text(item["version"], `${path}.version`, /^\S+$/u) };
  }
  return fail(`${path}.role`, "must be runtime or wheel");
}

/** Reads `upstream/lock.json`. Every field is checked, and unknown fields are refused, because this file decides what ships. */
export function decodeUpstreamLock(source: string): UpstreamLock {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error: unknown) {
    throw new Error("upstream/lock.json is not valid JSON", { cause: error });
  }
  const root = object(parsed, "the file", ["schemaVersion", "pyodide", "files"]);
  if (root["schemaVersion"] !== 1) fail("schemaVersion", "must be 1");
  const pyodide = object(root["pyodide"], "pyodide", ["version", "npm", "source"]);
  const npm = object(pyodide["npm"], "pyodide.npm", ["package", "version", "tarball", "integrity"]);
  const origin = object(pyodide["source"], "pyodide.source", ["repository", "tag", "commit"]);
  const list = root["files"];
  if (!Array.isArray(list) || list.length < 1 || list.length > 64) return fail("files", "must list one to 64 files");
  const files = Array.from<unknown>(list).map(decodeFile);
  const names = new Set(files.map(file => file.name));
  if (names.size !== files.length) fail("files", "names a file twice");
  return {
    pyodide: {
      version: text(pyodide["version"], "pyodide.version", /^\S+$/u),
      npm: { package: text(npm["package"], "pyodide.npm.package"), version: text(npm["version"], "pyodide.npm.version", /^\S+$/u), tarball: https(npm["tarball"], "pyodide.npm.tarball"), integrity: text(npm["integrity"], "pyodide.npm.integrity", INTEGRITY) },
      source: { repository: https(origin["repository"], "pyodide.source.repository"), tag: text(origin["tag"], "pyodide.source.tag", /^\S+$/u), commit: text(origin["commit"], "pyodide.source.commit", COMMIT) },
    },
    files,
  };
}
