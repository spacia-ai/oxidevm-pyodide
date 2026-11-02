import { ModuleError } from "./errors.ts";
import { isRecord, isStringArray } from "./records.ts";

/** What this module needs to know about one package of Pyodide's lock file. */
export interface LockedPackage {
  readonly name: string;
  /** The wheel's file name, which is also the name of the release artifact that carries it. */
  readonly fileName: string;
  readonly depends: readonly string[];
  /** The top-level modules the package provides (`imports`): `PIL` for pillow, `pylab` and `mpl_toolkits` for matplotlib. */
  readonly imports: readonly string[];
}

/** The packages of a Pyodide lock file by their normalized names, which is how `depends` names them too. */
export type Lockfile = ReadonlyMap<string, LockedPackage>;

function decodePackage(name: string, value: unknown): LockedPackage {
  if (!isRecord(value)) throw new ModuleError("lock-invalid", `The Pyodide lock's package ${name} must be an object`);
  const fileName = value["file_name"], depends = value["depends"] ?? [], imports = value["imports"] ?? [];
  if (typeof fileName !== "string" || fileName === "") throw new ModuleError("lock-invalid", `The Pyodide lock's package ${name} needs a file_name`);
  if (!isStringArray(depends)) throw new ModuleError("lock-invalid", `The Pyodide lock's package ${name} needs depends to be a list of names`);
  if (!isStringArray(imports)) throw new ModuleError("lock-invalid", `The Pyodide lock's package ${name} needs imports to be a list of names`);
  return { name, fileName, depends, imports };
}

/** Reads the lock file text. Only the fields this module uses are checked; Pyodide adds others from release to release. */
export function decodeLockfile(text: string): Lockfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    throw new ModuleError("lock-invalid", "The Pyodide lock is not valid JSON", { cause: error });
  }
  const packages = isRecord(parsed) ? parsed["packages"] : undefined;
  if (!isRecord(packages)) throw new ModuleError("lock-invalid", "The Pyodide lock has no packages object");
  return new Map(Object.entries(packages).map(([name, value]) => [name, decodePackage(name, value)]));
}

/** The requested packages and everything they depend on, each once, sorted by name. */
export function wheelsFor(lock: Lockfile, requested: readonly string[]): readonly LockedPackage[] {
  const found = new Map<string, LockedPackage>();
  const pending = [...requested];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (found.has(name)) continue;
    const entry = lock.get(name);
    if (entry === undefined) throw new ModuleError("package-unknown", `The Pyodide lock has no package ${name}`);
    found.set(name, entry);
    pending.push(...entry.depends);
  }
  return [...found.values()].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/**
 * The packages that load when a program imports one of their top-level modules: each import name of a package that
 * `ships` accepts, mapped to that package. A name two shipped packages claim is left out rather than guessed.
 */
export function importMap(lock: Lockfile, ships: (fileName: string) => boolean): ReadonlyMap<string, string> {
  const owners = new Map<string, string[]>();
  for (const entry of lock.values()) {
    if (!ships(entry.fileName)) continue;
    for (const name of entry.imports) owners.set(name, [...owners.get(name) ?? [], entry.name]);
  }
  return new Map([...owners].flatMap(([name, packages]) => packages.length === 1 && packages[0] !== undefined ? [[name, packages[0]] as const] : []));
}
