import { kit } from "@oxidevm/sdk/wasm";
import { describe, expect, it } from "vitest";
import { MAX_ARGUMENT_JSON_BYTES, nativeRunner } from "../src/native-bridge.ts";
import type { NativeHost } from "../src/native-bridge.ts";
import { processId } from "./support/brands.ts";
import { fakeProcess } from "./support/fake-process.ts";
import type { Child } from "./support/fake-process.ts";

function setup(behave: (argv: readonly string[]) => Child, signal: AbortSignal = new AbortController().signal) {
  const fake = fakeProcess(behave);
  const host: NativeHost = { ...fake.host, kit, signal };
  return { run: nativeRunner(host), spawned: fake.spawned, fake };
}

async function failure(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  return "no failure";
}

describe("the arguments of a native command", () => {
  it("are checked before anything is spawned", async () => {
    const { run, spawned } = setup(() => ({}));
    const bad: readonly unknown[] = [[], ["uname"], ["/bin/uname", null], ["/bin/una\0me"], Array<string>(65).fill("/bin/true"), {}, "text", 7];
    for (const argv of bad) await expect(run(JSON.stringify(argv), "", 1000), JSON.stringify(argv)).rejects.toThrow();
    for (const text of ["", "{", "[", "[\"/bin/true\"", undefined, null, 4, ["/bin/true"]]) await expect(run(text, "", 1000), String(text)).rejects.toThrow();
    expect(spawned).toHaveLength(0);
  });

  it("must not exceed 64 KiB as JSON text", async () => {
    const { run, spawned } = setup(() => ({}));
    const within = JSON.stringify(["/bin/true", "x".repeat(MAX_ARGUMENT_JSON_BYTES - 20)]);
    expect(new TextEncoder().encode(within).length).toBeLessThanOrEqual(MAX_ARGUMENT_JSON_BYTES);
    await expect(run(within, "", 1000)).resolves.toContain('"returncode":0');
    const over = JSON.stringify(["/bin/true", "x".repeat(MAX_ARGUMENT_JSON_BYTES)]);
    expect(await failure(run(over, "", 1000))).toBe("Native arguments exceed 64 KiB");
    // Characters count as their UTF-8 bytes: 22,000 three-byte characters are 66,000 bytes.
    expect(await failure(run(JSON.stringify(["/bin/true", "€".repeat(22_000)]), "", 1000))).toBe("Native arguments exceed 64 KiB");
    expect(spawned).toHaveLength(1);
  });

  it("must come with text input within 5 MiB and a timeout from 1 ms to 180 s", async () => {
    const { run, spawned } = setup(() => ({}));
    const command = JSON.stringify(["/bin/true"]);
    for (const timeout of [0, -1, 180_001, Number.NaN, 0.5, Number.POSITIVE_INFINITY]) await expect(run(command, "", timeout), String(timeout)).rejects.toThrow();
    // What is not a number or text is refused by this module's own check, before the kit sees it.
    for (const timeout of ["1000", null, undefined, 1000n]) expect(await failure(run(command, "", timeout)), String(timeout)).toBe("Native timeout must be a number");
    await expect(run(command, "x".repeat(5 * 1024 ** 2 + 1), 1000)).rejects.toThrow(/input exceeds/u);
    for (const input of [undefined, null, 5, new Uint8Array(2)]) expect(await failure(run(command, input, 1000)), String(input)).toBe("Native text input must be a string");
    expect(spawned).toHaveLength(0);
    await expect(run(command, "x".repeat(5 * 1024 ** 2), 180_000)).resolves.toContain("returncode");
    await expect(run(command, "", 1)).resolves.toContain("returncode");
  });
});

describe("a native command", () => {
  it("runs in the workspace with piped streams, and its result comes back as JSON", async () => {
    const { run, spawned } = setup(argv => ({ stdout: `ran ${argv.join(" ")}\n`, stderr: "warning\n", exit: { kind: "exited", code: 3 } }));
    const reply: unknown = JSON.parse(await run(JSON.stringify(["/bin/echo", "a", "b"]), "typed input", 5000));
    expect(reply).toEqual({ pid: 1000, returncode: 3, stdout: "ran /bin/echo a b\n", stderr: "warning\n" });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({ command: "/bin/echo", args: ["a", "b"], cwd: "/workspace", stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" }, input: "typed input", signals: [] });
    // Every pipe was closed.
    expect(spawned[0]?.closed).toBe(3);
  });

  it("reports the signal that ended it as a negative return code", async () => {
    const { run, spawned, fake } = setup(() => ({ hang: true }));
    const pending = run(JSON.stringify(["/bin/sleep", "100"]), "", 60_000);
    await expect.poll(() => spawned.length).toBe(1);
    // Something else (not this module) ends the child with SIGTERM.
    await fake.host.process.signal(processId(spawned[0]?.pid ?? 1), 15);
    expect(JSON.parse(await pending)).toMatchObject({ returncode: -15 });
  });

  it("is killed when the module stops, and the run fails with the reason", async () => {
    const controller = new AbortController();
    const { run, spawned } = setup(() => ({ hang: true }), controller.signal);
    const pending = run(JSON.stringify(["/bin/sleep", "100"]), "", 60_000);
    await expect.poll(() => spawned.length).toBe(1);
    controller.abort(new Error("module stopped"));
    await expect(pending).rejects.toThrow("module stopped");
    expect(spawned[0]?.signals).toEqual([9]);
  });

  it("is killed when it runs out of time", async () => {
    const { run, spawned } = setup(() => ({ hang: true }));
    expect(await failure(run(JSON.stringify(["/bin/sh", "-c", "while :; do :; done"]), "", 30))).toContain("timed out");
    expect(spawned[0]?.signals).toEqual([9]);
    expect(spawned[0]?.closed).toBe(3);
  });

  it("is refused when its output grows beyond 1 MiB, and killed", async () => {
    const { run, spawned } = setup(() => ({ stdout: new Uint8Array(1024 ** 2 + 1).fill(97), hang: true }));
    expect(await failure(run(JSON.stringify(["/bin/head", "-c", "1100000", "/dev/zero"]), "", 5000))).toContain("output limit");
    expect(spawned[0]?.signals).toEqual([9]);
  });

  it("accepts output of exactly 1 MiB", async () => {
    const { run } = setup(() => ({ stdout: "x".repeat(1024 ** 2) }));
    const reply: unknown = JSON.parse(await run(JSON.stringify(["/bin/cat"]), "", 5000));
    expect(reply).toMatchObject({ returncode: 0 });
    expect(reply instanceof Object && "stdout" in reply && typeof reply.stdout === "string" ? reply.stdout.length : 0).toBe(1024 ** 2);
  });
});
