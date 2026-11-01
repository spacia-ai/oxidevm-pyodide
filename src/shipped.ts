// The files this release carries, as types. The manifest in module.ts must list the same names literally (the build
// reads it without running code), and test/manifest.test.ts checks that the two agree with upstream/lock.json.

/** The Pyodide runtime: the interpreter, its standard library and the package index. */
export const RUNTIME_FILES = ["pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"] as const;

/** The wheels of the packages the module offers, by package name as Pyodide's lock file spells it. */
export const WHEELS = {
  contourpy: "contourpy-1.3.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
  cycler: "cycler-0.12.1-py3-none-any.whl",
  fonttools: "fonttools-4.62.1-py3-none-any.whl",
  kiwisolver: "kiwisolver-1.5.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
  matplotlib: "matplotlib-3.10.8-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
  numpy: "numpy-2.4.6-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
  packaging: "packaging-26.1-py3-none-any.whl",
  pandas: "pandas-3.0.2-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
  pillow: "pillow-12.2.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl",
  pyparsing: "pyparsing-3.3.2-py3-none-any.whl",
  "python-dateutil": "python_dateutil-2.9.0.post0-py2.py3-none-any.whl",
  pytz: "pytz-2026.1.post1-py2.py3-none-any.whl",
  six: "six-1.17.0-py2.py3-none-any.whl",
} as const;

/** The commands the module declares (`commands` in the manifest, sorted): both run Python, and argv[0] says which was typed. */
export const COMMANDS = ["python", "python3"] as const;
export type PythonCommand = (typeof COMMANDS)[number];

/** The notices the release carries (`license.notices` in the manifest). */
export const NOTICE_FILES = ["NOTICES.txt", "SOURCE-OFFER.md"] as const;

export type PackageName = keyof typeof WHEELS;
export type RuntimeFile = (typeof RUNTIME_FILES)[number];
export type WheelFile = (typeof WHEELS)[PackageName];
export type NoticeFile = (typeof NOTICE_FILES)[number];
/** Every artifact of the release. */
export type ShippedFile = RuntimeFile | WheelFile | NoticeFile;

/** The packages a program may ask for, in the order the manifest lists them. */
export const PACKAGE_NAMES = Object.keys(WHEELS).filter((name): name is PackageName => Object.hasOwn(WHEELS, name));

export function isWheelFile(name: string): name is WheelFile {
  return Object.values<string>(WHEELS).includes(name);
}
