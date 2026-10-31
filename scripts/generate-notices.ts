// Writes NOTICES.txt and SOURCE-OFFER.md from what the release carries: upstream/lock.json, the wheels in upstream/ (their
// own licence files and metadata) and the pinned licence texts in legal/. Nothing is typed in by hand, so the two files
// cannot drift from the release.
//
//   node scripts/generate-notices.ts            write both files
//   node scripts/generate-notices.ts --check    fail when either file differs from what would be written
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { incorporatedSection, renderNotices, renderSourceOffer, sha256Hex, verifyRecorded, wheelNotice } from "./notices.ts";
import type { ProjectText } from "./notices.ts";
import { decodeUpstreamLock } from "./upstream-lock.ts";
import { isRecord } from "../src/records.ts";

const INCORPORATED_FILE = "cpython-incorporated-software.rst";

function decodeTexts(source: string): readonly { readonly file: string; readonly title: string; readonly spdx: string; readonly source: string; readonly sha256: string; readonly appliesTo: string }[] {
  const root: unknown = JSON.parse(source);
  const texts = isRecord(root) ? root["texts"] : undefined;
  if (!isRecord(root) || root["schemaVersion"] !== 1 || !Array.isArray(texts)) throw new Error("legal/texts.json must be { schemaVersion: 1, note, texts: [...] }");
  return Array.from<unknown>(texts).map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`legal/texts.json texts[${String(index)}] must be an object`);
    const keys = Object.keys(entry).sort().join(",");
    if (keys !== "appliesTo,file,sha256,source,spdx,title") throw new Error(`legal/texts.json texts[${String(index)}] has the fields ${keys}`);
    const { file, title, spdx, source: where, sha256, appliesTo } = entry;
    if (typeof file !== "string" || typeof title !== "string" || typeof spdx !== "string" || typeof where !== "string" || typeof sha256 !== "string" || typeof appliesTo !== "string") throw new Error(`legal/texts.json texts[${String(index)}] has a field that is not text`);
    return { file, title, spdx, source: where, sha256, appliesTo };
  });
}

export interface Generated {
  readonly notices: string;
  readonly sourceOffer: string;
}

/** Builds both files from the repository at `root`. Fails if a pinned file is missing or differs from its pin. */
export async function generate(root: string): Promise<Generated> {
  const lock = decodeUpstreamLock(await readFile(join(root, "upstream/lock.json"), "utf8"));
  const runtime: ProjectText[] = [];
  for (const entry of decodeTexts(await readFile(join(root, "legal/texts.json"), "utf8"))) {
    const bytes = new Uint8Array(await readFile(join(root, "legal", entry.file)));
    if (sha256Hex(bytes) !== entry.sha256) throw new Error(`legal/${entry.file} does not match the sha256 pinned in legal/texts.json`);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    runtime.push({ title: entry.title, spdx: entry.spdx, source: entry.source, appliesTo: entry.appliesTo, sha256: entry.sha256, text: entry.file === INCORPORATED_FILE ? incorporatedSection(text) : text });
  }
  const wheels = [];
  for (const file of lock.files) {
    if (file.role !== "wheel") continue;
    const bytes = new Uint8Array(await readFile(join(root, "upstream", file.name)));
    if (sha256Hex(bytes) !== file.sha256) throw new Error(`upstream/${file.name} does not match upstream/lock.json (run: pnpm run fetch-upstream)`);
    const notice = wheelNotice(file, bytes);
    verifyRecorded(notice);
    wheels.push(notice);
  }
  wheels.sort((left, right) => (left.package < right.package ? -1 : left.package > right.package ? 1 : 0));
  const spdx = /^\s*spdx: "([^"]+)"/mu.exec(await readFile(join(root, "module.ts"), "utf8"))?.[1];
  if (spdx === undefined) throw new Error("module.ts has no license.spdx");
  return { notices: renderNotices({ lock, runtime, wheels, spdx }), sourceOffer: renderSourceOffer(lock) };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { check: { type: "boolean" } }, strict: true });
  const root = resolve(import.meta.dirname, "..");
  try {
    const generated = await generate(root);
    const files = [["NOTICES.txt", generated.notices], ["SOURCE-OFFER.md", generated.sourceOffer]] as const;
    if (values.check === true) {
      const stale: string[] = [];
      for (const [name, content] of files) if (await readFile(join(root, name), "utf8").catch(() => undefined) !== content) stale.push(name);
      if (stale.length > 0) throw new Error(`${stale.join(" and ")} out of date; run: pnpm run notices`);
      process.stdout.write("NOTICES.txt and SOURCE-OFFER.md are up to date\n");
    } else {
      for (const [name, content] of files) await writeFile(join(root, name), content);
      process.stdout.write(`wrote NOTICES.txt (${String(generated.notices.length)} characters) and SOURCE-OFFER.md\n`);
    }
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
