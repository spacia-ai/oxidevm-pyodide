import { createHash } from "node:crypto";
import { readZip } from "./zip.ts";
import type { UpstreamLock, WheelFile } from "./upstream-lock.ts";

/** A licence text and every path (inside a wheel, or in this repository) at which it was found. */
export interface LicenseText {
  readonly paths: readonly string[];
  readonly text: string;
}

/** What this release records about one wheel's licence, checked against the wheel's own metadata. */
export interface RecordedWheel {
  /** The licence of the wheel's code and what it bundles, as an SPDX expression. */
  readonly spdx: string;
  /** Where the source is. */
  readonly source: string;
  /** Words the wheel's licence text must contain, as a guard against recording the wrong licence. */
  readonly evidence: readonly string[];
}

/**
 * The licence this release records for each wheel, and the reason to believe it: the wheel's own metadata and licence
 * files. The generator refuses a wheel whose metadata says something else or whose licence files lack the evidence.
 */
export const RECORDED: Readonly<Record<string, RecordedWheel>> = {
  certifi: { spdx: "MPL-2.0", source: "https://github.com/certifi/python-certifi", evidence: ["Mozilla Public License"] },
  "charset-normalizer": { spdx: "MIT", source: "https://github.com/jawah/charset_normalizer", evidence: ["Permission is hereby granted, free of charge"] },
  contourpy: { spdx: "BSD-3-Clause", source: "https://github.com/contourpy/contourpy", evidence: ["Neither the name of the copyright holder"] },
  cycler: { spdx: "BSD-3-Clause", source: "https://github.com/matplotlib/cycler", evidence: ["Neither the name of the matplotlib project"] },
  fonttools: { spdx: "MIT", source: "https://github.com/fonttools/fonttools", evidence: ["Permission is hereby granted, free of charge"] },
  h11: { spdx: "MIT", source: "https://github.com/python-hyper/h11", evidence: ["Permission is hereby granted, free of charge"] },
  httpcore: { spdx: "BSD-3-Clause", source: "https://github.com/encode/httpcore", evidence: ["Neither the name of the copyright holder"] },
  httpx: { spdx: "BSD-3-Clause", source: "https://github.com/encode/httpx", evidence: ["Neither the name of the copyright holder"] },
  idna: { spdx: "BSD-3-Clause", source: "https://github.com/kjd/idna", evidence: ["Neither the name of the copyright holder"] },
  kiwisolver: { spdx: "BSD-3-Clause", source: "https://github.com/nucleic/kiwi", evidence: ["Modified BSD License", "Neither the name of the Nucleic Development Team"] },
  matplotlib: { spdx: "LicenseRef-Matplotlib AND OFL-1.1 AND Bitstream-Vera", source: "https://github.com/matplotlib/matplotlib", evidence: ["License agreement for matplotlib versions 1.3.0 and later", "SIL OPEN FONT LICENSE", "Bitstream Vera"] },
  numpy: { spdx: "BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0", source: "https://github.com/numpy/numpy", evidence: ["Redistributions in binary form must reproduce"] },
  packaging: { spdx: "Apache-2.0 OR BSD-2-Clause", source: "https://github.com/pypa/packaging", evidence: ["Apache License", "Redistributions in binary form must reproduce"] },
  pandas: { spdx: "BSD-3-Clause", source: "https://github.com/pandas-dev/pandas", evidence: ["Neither the name"] },
  pillow: { spdx: "MIT-CMU", source: "https://github.com/python-pillow/Pillow", evidence: ["MIT-CMU License"] },
  pyparsing: { spdx: "MIT", source: "https://github.com/pyparsing/pyparsing", evidence: ["Permission is hereby granted, free of charge"] },
  "python-dateutil": { spdx: "BSD-3-Clause AND Apache-2.0", source: "https://github.com/dateutil/dateutil", evidence: ["Redistributions in binary form must reproduce", "Apache License"] },
  pytz: { spdx: "MIT", source: "https://github.com/stub42/pytz", evidence: ["Permission is hereby granted, free of charge"] },
  requests: { spdx: "Apache-2.0", source: "https://github.com/psf/requests", evidence: ["Apache License"] },
  six: { spdx: "MIT", source: "https://github.com/benjaminp/six", evidence: ["Permission is hereby granted, free of charge"] },
  urllib3: { spdx: "MIT", source: "https://github.com/urllib3/urllib3", evidence: ["Permission is hereby granted, free of charge"] },
};

export interface WheelNotice {
  readonly package: string;
  readonly version: string;
  readonly file: string;
  readonly sha256: string;
  /** What the wheel's metadata declares: its license expression, or the start of its license field. */
  readonly declared: string;
  readonly recorded: RecordedWheel;
  readonly texts: readonly LicenseText[];
}

/** The headers of a wheel's METADATA (the part before the first blank line), by name; repeated headers keep every value. */
export function parseMetadata(text: string): ReadonlyMap<string, readonly string[]> {
  const headers = new Map<string, string[]>();
  let last: string[] | undefined;
  for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
    if (line === "") break;
    if (/^\s/u.test(line)) {
      if (last !== undefined && last.length > 0) last[last.length - 1] = `${last.at(-1) ?? ""}\n${line.trim()}`;
      continue;
    }
    const cut = line.indexOf(":");
    if (cut < 1) continue;
    const name = line.slice(0, cut).toLowerCase();
    last = headers.get(name) ?? [];
    headers.set(name, last);
    last.push(line.slice(cut + 1).trim());
  }
  return headers;
}

/** What the metadata declares about the licence, in one line. */
export function declaredLicense(metadata: ReadonlyMap<string, readonly string[]>): string {
  const expression = metadata.get("license-expression")?.[0];
  if (expression !== undefined) return expression;
  const field = metadata.get("license")?.[0];
  const classifiers = (metadata.get("classifier") ?? []).filter(value => value.startsWith("License ::")).map(value => value.replace(/^License :: (OSI Approved :: )?/u, ""));
  const first = field?.split("\n")[0]?.trim() ?? "";
  const summary = first.length > 80 ? `${first.slice(0, 77)}...` : first;
  return [summary, ...classifiers.map(value => `classifier: ${value}`)].filter(part => part !== "").join("; ") || "none declared";
}

// NOTICE files count too: Apache-2.0 section 4(d) asks for their text (requests carries one).
const LICENSE_FILE = /(^|\/)(LICEN[CS]E|COPYING|NOTICE)([._-][^/]*)?$|(^|\/)LICEN[CS]E[._-][A-Za-z]+$/iu;

function normalize(text: string): string {
  return `${text.replaceAll("\r\n", "\n").trimEnd()}\n`;
}

/** Collects the licence texts a wheel carries, merging files with identical text into one entry that lists all its paths. */
export function wheelNotice(wheel: WheelFile, bytes: Uint8Array): WheelNotice {
  const entries = readZip(bytes);
  const metadataEntry = entries.find(entry => /^[^/]+\.dist-info\/METADATA$/u.test(entry.name));
  if (metadataEntry === undefined) throw new Error(`${wheel.name} has no dist-info/METADATA`);
  const metadata = parseMetadata(new TextDecoder("utf-8", { fatal: true }).decode(metadataEntry.read()));
  const version = metadata.get("version")?.[0];
  if (version !== wheel.version) throw new Error(`${wheel.name}: the wheel says version ${version ?? "none"}, the lock says ${wheel.version}`);
  const byText = new Map<string, string[]>();
  for (const entry of entries.filter(candidate => LICENSE_FILE.test(candidate.name) && candidate.size > 0).sort((left, right) => (left.name < right.name ? -1 : 1))) {
    const text = normalize(new TextDecoder("utf-8", { fatal: true }).decode(entry.read()));
    byText.set(text, [...byText.get(text) ?? [], entry.name]);
  }
  const recorded = RECORDED[wheel.package];
  if (recorded === undefined) throw new Error(`no licence is recorded for ${wheel.package}; add it to RECORDED after reading its licence files`);
  return {
    package: wheel.package, version: wheel.version, file: wheel.name, sha256: wheel.sha256,
    declared: declaredLicense(metadata), recorded, texts: [...byText].map(([text, paths]) => ({ paths, text })),
  };
}

/** Refuses a wheel whose metadata or licence files do not support the licence recorded for it. */
export function verifyRecorded(notice: WheelNotice): void {
  const expression = notice.declared;
  if (/^[A-Za-z0-9.+-]+(?: (?:AND|OR|WITH) [A-Za-z0-9.+-]+)*$/u.test(expression) && expression !== notice.recorded.spdx) {
    throw new Error(`${notice.package}: the wheel declares ${expression} but this release records ${notice.recorded.spdx}`);
  }
  const all = notice.texts.map(entry => entry.text).join("\n");
  for (const word of notice.recorded.evidence) {
    if (!all.includes(word)) throw new Error(`${notice.package}: its licence files do not contain "${word}", which supports the recorded ${notice.recorded.spdx}`);
  }
}

/** A licence text from `legal/`, with where it came from. */
export interface ProjectText {
  readonly title: string;
  readonly spdx: string;
  readonly source: string;
  readonly appliesTo: string;
  readonly text: string;
  readonly sha256: string;
}

const RULE = "=".repeat(78);
const THIN = "-".repeat(78);
const INCORPORATED_HEADING = "Licenses and Acknowledgements for Incorporated Software";

/** From the CPython documentation page, the part that lists incorporated software; the rest repeats the PSF licence. */
export function incorporatedSection(rst: string): string {
  const start = rst.indexOf(`\n${INCORPORATED_HEADING}\n`);
  if (start < 0) throw new Error(`the CPython licence page has no section "${INCORPORATED_HEADING}"`);
  return rst.slice(start + 1);
}

function indented(text: string): string {
  return normalize(text).split("\n").map(line => (line === "" ? "" : `    ${line}`)).join("\n").trimEnd();
}

export interface NoticesInput {
  readonly lock: UpstreamLock;
  readonly runtime: readonly ProjectText[];
  readonly wheels: readonly WheelNotice[];
  /** The SPDX expression of the manifest, repeated in the summary. */
  readonly spdx: string;
}

/** The text of NOTICES.txt. It is a function of its inputs only, so that a test can compare it with the committed file. */
export function renderNotices(input: NoticesInput): string {
  const { lock, runtime, wheels } = input;
  const out: string[] = [];
  out.push("NOTICES for the oxidevm-pyodide release", RULE, "");
  out.push(
    `This release carries the Pyodide ${lock.pyodide.version} runtime and ${String(wheels.length)} Python wheels exactly as their projects published them, without`,
    "change, plus the code of this module (module.ts and src/, Apache-2.0, Copyright 2026 Spacia B.V.; see LICENSE). This file reproduces",
    "the licence texts and notices that go with them. Every licence text below is the file at the commit named beside it,",
    "or the file inside the wheel; scripts/generate-notices.ts assembles this file from them, and a test fails if it is out of date.",
    "",
    "The licence expression of the release, as declared in its manifest:",
    `    ${input.spdx}`,
    "",
    "Components and licences",
    THIN,
  );
  for (const text of runtime) out.push(`- ${text.title}: ${text.spdx}`);
  for (const wheel of wheels) out.push(`- ${wheel.package} ${wheel.version} (wheel): ${wheel.recorded.spdx}`);
  out.push(
    "- SQLite 3.39.0 and the liblzma of xz 5.2.2, linked into pyodide.asm.wasm according to Pyodide's cpython/Makefile: in the public domain",
    "  according to their projects' own notices (https://www.sqlite.org/copyright.html, https://tukaani.org/xz/), so no text is reproduced.",
    "",
    "The statically linked libraries of pyodide.asm.wasm are listed from Pyodide's build files and from the binary itself; they",
    "have not been audited component by component. Where a text is missing here, the project named above holds it.",
    "",
  );
  out.push(RULE, "PART 1. THE PYODIDE RUNTIME (pyodide.asm.wasm, python_stdlib.zip, pyodide-lock.json, and the JavaScript bundled into adapter.mjs)", RULE, "");
  for (const text of runtime) {
    out.push(THIN, text.title, `Licence: ${text.spdx}`, `Applies to: ${text.appliesTo}`, `Source: ${text.source}`, `sha256 of the text: ${text.sha256}`, THIN, "", normalize(text.text).trimEnd(), "");
  }
  out.push(RULE, "PART 2. PYTHON PACKAGES (the wheels)", RULE, "");
  for (const wheel of wheels) {
    out.push(
      THIN, `${wheel.package} ${wheel.version}`, `Licence recorded for this release: ${wheel.recorded.spdx}`, `Declared by the wheel: ${wheel.declared}`,
      `Source: ${wheel.recorded.source}`, `Wheel: ${wheel.file}`, `sha256 of the wheel: ${wheel.sha256}`, THIN, "",
    );
    for (const entry of wheel.texts) out.push(`Licence text, found at ${entry.paths.join(", ")}:`, "", indented(entry.text), "");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

/** The text of SOURCE-OFFER.md. */
export function renderSourceOffer(lock: UpstreamLock): string {
  const { pyodide, files } = lock;
  const rows = files.map(file => `| ${file.name} | ${file.role === "wheel" ? `${file.package} ${file.version}` : "Pyodide runtime"} | \`${file.sha256}\` | ${String(file.bytes)} |`);
  return [
    "# Source offer",
    "",
    "This release contains the Pyodide runtime, which is licensed under the Mozilla Public License 2.0, and Python wheels under",
    "other open-source licences (see `NOTICES.txt`). None of them is modified: the files in the release are the files the",
    "projects published, and the table below gives the sha256 of each so that you can check that.",
    "",
    "## Where the source of the MPL-2.0 parts is",
    "",
    `The Source Code Form of Pyodide ${pyodide.version} (the interpreter build \`pyodide.asm.wasm\`, \`python_stdlib.zip\`, \`pyodide-lock.json\`, and the`,
    "JavaScript of `pyodide.mjs` and `pyodide.asm.mjs`, which is bundled into `adapter.mjs`) is available from the Pyodide project:",
    "",
    `- repository: ${pyodide.source.repository}`,
    `- tag: \`${pyodide.source.tag}\``,
    `- commit: \`${pyodide.source.commit}\``,
    `- the published npm package: \`${pyodide.npm.package}@${pyodide.npm.version}\` (${pyodide.npm.tarball}), integrity \`${pyodide.npm.integrity}\``,
    "",
    "The wasm file is built from that source by the Pyodide project's own build, using the CPython, Emscripten and library versions",
    "that its `cpython/Makefile` and `Makefile.envs` name. You can obtain the source from the locations above without charge.",
    "",
    "## How to check that the release is what it says it is",
    "",
    "```sh",
    "pnpm install",
    "pnpm run fetch-upstream   # downloads each file and refuses any whose sha256 differs from upstream/lock.json",
    "pnpm run build            # writes dist/ with module.json, adapter.mjs, the artifacts and SHA256SUMS",
    "```",
    "",
    "## The files, as mirrored",
    "",
    "| file | what | sha256 | bytes |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "The wheels are built by the Pyodide project for its WebAssembly platform and published on the Pyodide CDN",
    "(`https://cdn.jsdelivr.net/pyodide/v" + pyodide.version + "/full/`); the home of each package's source is named in `NOTICES.txt`.",
    "",
  ].join("\n");
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
