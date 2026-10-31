import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyLicense } from "@oxidevm/sdk/wasm";
import { describe, expect, it } from "vitest";
import { generate } from "../scripts/generate-notices.ts";
import { declaredLicense, incorporatedSection, parseMetadata, RECORDED, renderNotices, verifyRecorded } from "../scripts/notices.ts";
import type { WheelNotice } from "../scripts/notices.ts";
import { decodeUpstreamLock } from "../scripts/upstream-lock.ts";
import definition from "../module.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("parseMetadata", () => {
  it("reads headers up to the first blank line, keeps repeated headers, and folds continuation lines", () => {
    const headers = parseMetadata("Metadata-Version: 2.4\nName: demo\nClassifier: A :: B\nClassifier: C :: D\nLicense: first line\n second line\n\nDescription body\nName: not a header\n");
    expect(headers.get("name")).toEqual(["demo"]);
    expect(headers.get("classifier")).toEqual(["A :: B", "C :: D"]);
    expect(headers.get("license")).toEqual(["first line\nsecond line"]);
    expect(headers.get("description body")).toBeUndefined();
  });

  it("accepts Windows line endings", () => {
    expect(parseMetadata("Name: demo\r\nVersion: 1\r\n\r\nbody").get("version")).toEqual(["1"]);
  });
});

describe("declaredLicense", () => {
  it("prefers the licence expression", () => {
    expect(declaredLicense(parseMetadata("License-Expression: MIT AND Zlib\nLicense: other"))).toBe("MIT AND Zlib");
  });

  it("falls back to the start of the licence field and the classifiers, and says when there is neither", () => {
    expect(declaredLicense(parseMetadata("License: BSD 3-Clause License\nClassifier: License :: OSI Approved :: BSD License\nClassifier: Programming Language :: Python"))).toBe("BSD 3-Clause License; classifier: BSD License");
    expect(declaredLicense(parseMetadata(`License: ${"x".repeat(200)}`))).toBe(`${"x".repeat(77)}...`);
    expect(declaredLicense(parseMetadata("Name: demo"))).toBe("none declared");
  });
});

describe("incorporatedSection", () => {
  it("keeps the part of the CPython page that lists incorporated software", () => {
    expect(incorporatedSection("Intro\n\nLicenses and Acknowledgements for Incorporated Software\n===\n\nexpat\n")).toBe("Licenses and Acknowledgements for Incorporated Software\n===\n\nexpat\n");
    expect(() => incorporatedSection("no such section")).toThrow("Licenses and Acknowledgements");
  });
});

describe("verifyRecorded", () => {
  const notice = (declared: string, text: string, spdx = "MIT"): WheelNotice => ({
    package: "demo", version: "1", file: "demo.whl", sha256: "0".repeat(64), declared,
    recorded: { spdx, source: "https://example.com", evidence: ["Permission is hereby granted"] },
    texts: [{ paths: ["LICENSE"], text }],
  });

  it("accepts a wheel whose metadata and texts agree with the record", () => {
    expect(() => { verifyRecorded(notice("MIT", "Permission is hereby granted, free of charge")); }).not.toThrow();
    expect(() => { verifyRecorded(notice("MIT License; classifier: MIT License", "Permission is hereby granted")); }).not.toThrow();
  });

  it("refuses a wheel whose metadata declares another licence expression", () => {
    expect(() => { verifyRecorded(notice("Apache-2.0", "Permission is hereby granted")); }).toThrow("declares Apache-2.0 but this release records MIT");
  });

  it("refuses a wheel whose licence files lack the evidence for the recorded licence", () => {
    expect(() => { verifyRecorded(notice("none declared", "Some other terms")); }).toThrow("Permission is hereby granted");
  });
});

describe("renderNotices", () => {
  it("is a function of its inputs: same inputs, same text, and every component appears", () => {
    const lock = decodeUpstreamLock(JSON.stringify({
      schemaVersion: 1,
      pyodide: { version: "1.2.3", npm: { package: "pyodide", version: "1.2.3", tarball: "https://example.com/p.tgz", integrity: `sha512-${"A".repeat(86)}==` }, source: { repository: "https://example.com/p", tag: "1.2.3", commit: "a".repeat(40) } },
      files: [{ name: "x.wasm", role: "runtime", url: "https://example.com/x.wasm", sha256: "b".repeat(64), bytes: 5 }],
    }));
    const input = {
      lock, spdx: "MIT",
      runtime: [{ title: "The runtime", spdx: "MPL-2.0", source: "https://example.com/LICENSE", appliesTo: "everything", text: "Licence text\r\n", sha256: "c".repeat(64) }],
      wheels: [{ package: "demo", version: "1", file: "demo.whl", sha256: "d".repeat(64), declared: "MIT", recorded: { spdx: "MIT", source: "https://example.com/demo", evidence: [] }, texts: [{ paths: ["a/LICENSE", "b/LICENSE"], text: "MIT text\n" }] }],
    };
    const first = renderNotices(input);
    expect(renderNotices(input)).toBe(first);
    for (const expected of ["The runtime", "Licence: MPL-2.0", "Licence text\n", "demo 1", "Licence recorded for this release: MIT", "found at a/LICENSE, b/LICENSE", "    MIT text", "sha256 of the wheel: " + "d".repeat(64)]) expect(first).toContain(expected);
    expect(first).not.toContain("\r");
    expect(first.endsWith("\n")).toBe(true);
  });
});

describe("the committed notices (run `pnpm run notices` when this fails)", () => {
  it("are what the generator makes from the wheels, the pinned texts and the manifest", async () => {
    const generated = await generate(root);
    expect(await readFile(join(root, "NOTICES.txt"), "utf8")).toBe(generated.notices);
    expect(await readFile(join(root, "SOURCE-OFFER.md"), "utf8")).toBe(generated.sourceOffer);
  });

  it("record a licence for every wheel the lock carries, and for no other", async () => {
    const lock = decodeUpstreamLock(await readFile(join(root, "upstream/lock.json"), "utf8"));
    const wheels = lock.files.flatMap(file => (file.role === "wheel" ? [file.package] : []));
    expect(Object.keys(RECORDED).sort()).toEqual([...wheels].sort());
  });

  it("are covered by the manifest's licence expression: every licence they name is in license.spdx", async () => {
    const declared = new Set(classifyLicense(definition.manifest.license.spdx).ids);
    const texts: unknown = JSON.parse(await readFile(join(root, "legal/texts.json"), "utf8"));
    const spdxOfTexts = (typeof texts === "object" && texts !== null && "texts" in texts && Array.isArray(texts.texts) ? Array.from<unknown>(texts.texts) : []).flatMap(entry => (typeof entry === "object" && entry !== null && "spdx" in entry && typeof entry.spdx === "string" && entry.spdx !== "various" ? [entry.spdx] : []));
    const needed = new Set([...spdxOfTexts, ...Object.values(RECORDED).flatMap(item => classifyLicense(item.spdx).ids), "Apache-2.0"]);
    expect([...needed].filter(id => !declared.has(id)).sort()).toEqual([]);
    expect(definition.manifest.license.spdx.length).toBeLessThanOrEqual(256);
  });
});
