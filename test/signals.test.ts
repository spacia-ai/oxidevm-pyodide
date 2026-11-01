import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Worker } from "node:worker_threads";
import { LinuxError } from "@oxidevm/sdk/js-process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PYTHON_VERSION } from "../src/cli.ts";
import { ModuleError } from "../src/errors.ts";
import { catchInterrupts, createInterrupts, endBySignal, SLEEP_POLL_MS } from "../src/signals.ts";
import { normalised, oracle, oracleCase, oracleFiles } from "./support/cpython-oracle.ts";
import { fakeSignals } from "./support/fake-signals.ts";
import { startGuest } from "./support/guest-fixture.ts";
import type { GuestFixture } from "./support/guest-fixture.ts";

// Ctrl+C: SIGINT is trapped once Pyodide has loaded, the runtime writes it into Pyodide's interrupt buffer, and Python
// raises KeyboardInterrupt. A program that leaves it unhandled ends the way CPython ends, killed by SIGINT. Real signal
// delivery needs the SDK runtime; here a test writes the buffer where the runtime would, from another thread when the
// program is busy, as the runtime's driver does.

/** Writes SIGINT into the buffer from another thread after `afterMs`, while this thread may be busy running Python. */
function interruptFromAnotherThread(buffer: Int32Array, afterMs: number): void {
  const worker = new Worker(`const { workerData } = require("node:worker_threads"); setTimeout(() => { Atomics.store(new Int32Array(workerData), 0, 2); }, ${String(afterMs)});`, { eval: true, workerData: buffer.buffer });
  worker.unref();
}

/** A stand-in for Pyodide that records what Ctrl+C asks of it. */
function interruptTarget(): { readonly target: { setInterruptBuffer(buffer: Int32Array): void; checkInterrupt(): void }; readonly given: Int32Array[]; readonly checks: number[] } {
  const given: Int32Array[] = [], checks: number[] = [];
  return { given, checks, target: { setInterruptBuffer: buffer => { given.push(buffer); }, checkInterrupt: () => { checks.push(given.at(-1)?.[0] ?? -1); } } };
}

describe("catchInterrupts", () => {
  it("traps SIGINT alone and gives its interrupt buffer to the waits, and to Pyodide once the runner arms it", async () => {
    const fake = fakeSignals();
    const interrupts = createInterrupts();
    const pyodide = interruptTarget();
    const trap = await catchInterrupts(fake.signals, interrupts);
    expect(fake.calls).toEqual(["trap SIGINT"]);
    expect(trap.signals).toEqual(["SIGINT"]);
    fake.buffer[0] = 2;
    interrupts.hold();
    expect(fake.buffer[0]).toBe(0);
    interrupts.restore();
    expect(pyodide.given).toEqual([]);
    interrupts.arm(pyodide.target);
    expect(pyodide.given).toHaveLength(1);
    expect(pyodide.given[0]).toBe(fake.buffer);
    // Arming checks at once, so that a Ctrl+C that came before the program is raised as it starts.
    expect(pyodide.checks).toEqual([2]);
  });
});

describe("createInterrupts", () => {
  it("holds a pending Ctrl+C until Python runs again, then puts it back", () => {
    const interrupts = createInterrupts(), buffer = new Int32Array(1);
    interrupts.attach(buffer);
    buffer[0] = 2;
    interrupts.hold();
    expect(buffer[0]).toBe(0);
    interrupts.hold();
    interrupts.restore();
    expect(buffer[0]).toBe(2);
    buffer[0] = 0;
    interrupts.restore();
    expect(buffer[0]).toBe(0);
  });

  it("keeps a newer Ctrl+C that is already waiting, and holds or arms nothing before SIGINT is trapped", () => {
    const interrupts = createInterrupts(), buffer = new Int32Array(1);
    const pyodide = interruptTarget();
    interrupts.hold();
    interrupts.restore();
    interrupts.arm(pyodide.target);
    expect([pyodide.given, pyodide.checks]).toEqual([[], []]);
    interrupts.attach(buffer);
    buffer[0] = 2;
    interrupts.hold();
    buffer[0] = 15;
    interrupts.restore();
    expect(buffer[0]).toBe(15);
  });

  it("sleeps for the time asked, and ends a sleep as soon as a Ctrl+C is pending, holding it", async () => {
    const interrupts = createInterrupts(), buffer = new Int32Array(1);
    interrupts.attach(buffer);
    let began = performance.now();
    await interrupts.sleep(60);
    expect(performance.now() - began).toBeGreaterThanOrEqual(55);
    began = performance.now();
    setTimeout(() => { buffer[0] = 2; }, 30);
    await interrupts.sleep(10_000);
    expect(performance.now() - began).toBeLessThan(30 + 10 * SLEEP_POLL_MS);
    expect(buffer[0]).toBe(0);
    interrupts.restore();
    expect(buffer[0]).toBe(2);
  });
});

describe("endBySignal", () => {
  it("gives SIGINT back its default action, then raises it, so that the process ends killed by SIGINT", async () => {
    const fake = fakeSignals();
    const trap = await fake.signals.trap(["SIGINT"]);
    void endBySignal(fake.signals, trap);
    expect(await fake.raised).toBe("SIGINT");
    expect(fake.calls).toEqual(["trap SIGINT", "untrap", "raise SIGINT"]);
  });

  it("fails loudly when raising SIGINT did not end the process", async () => {
    const fake = fakeSignals();
    const trap = await fake.signals.trap(["SIGINT"]);
    await expect(endBySignal({ ...fake.signals, raise: () => Promise.resolve() }, trap)).rejects.toThrow(ModuleError);
  });
});

describe("Ctrl+C in the program", () => {
  let guest: GuestFixture;
  type Hook = Pick<GuestFixture["stdio"]["files"], "read" | "writeAll">;
  let original: Hook;
  beforeAll(async () => {
    guest = await startGuest(() => ({ hang: true }));
    original = { read: guest.stdio.files.read, writeAll: guest.stdio.files.writeAll };
    for (const [path, text] of oracleFiles()) {
      await mkdir(dirname(guest.files.real(path)), { recursive: true });
      await writeFile(guest.files.real(path), text);
    }
  });
  afterAll(async () => { await guest.stop(); await guest.dispose(); });
  beforeEach(() => { guest.interrupts[0] = 0; });
  afterEach(() => { Object.assign(guest.stdio.files, original); });

  /** Presses Ctrl+C from another thread shortly after the program's standard output first says `text`. */
  function interruptAfter(text: string, afterMs = 30): void {
    let armed = true;
    guest.stdio.files.writeAll = (fd, bytes) => {
      original.writeAll(fd, bytes);
      if (armed && fd === guest.stdio.streams.stdout && new TextDecoder().decode(bytes).includes(text)) {
        armed = false;
        interruptFromAnotherThread(guest.interrupts, afterMs);
      }
    };
  }

  it("ends an unhandled KeyboardInterrupt as CPython 3.14 does: traceback, atexit, then SIGINT", async () => {
    const recorded = oracleCase("keyboard-interrupt");
    expect(recorded.exit).toEqual({ kind: "signaled", signal: "SIGINT" });
    const module = { executable: "/usr/local/bin/python3", version: PYTHON_VERSION };
    expect(await guest.runCommandLine(recorded.argv.slice(1), { cwd: oracle.provenance.cwd, stdin: recorded.stdin }))
      .toEqual({ status: "SIGINT", stdout: normalised(recorded.stdout, module), stderr: normalised(recorded.stderr, module) });
  });

  it("raises a Ctrl+C that came before the program started as it starts, so that no line of it runs", async () => {
    guest.interrupts[0] = 2;
    expect(await guest.run("print('started')\n")).toEqual({ status: "SIGINT", stdout: "", stderr: "" });
  });

  it("interrupts a busy loop", async () => {
    interruptAfter("ready");
    // Bounded, so that a Ctrl+C that never arrives fails the test instead of spinning for ever.
    const result = await guest.run("import atexit, time\natexit.register(lambda: print('atexit ran'))\nprint('ready', flush=True)\nend = time.monotonic() + 20\nwhile time.monotonic() < end:\n    pass\n");
    expect(result).toMatchObject({ status: "SIGINT", stdout: "ready\natexit ran\n" });
    expect(result.stderr).toMatch(/^Traceback \(most recent call last\):\n {2}File "\/workspace\/program\.py", line [56], in <module>\n[\s\S]*\nKeyboardInterrupt\n$/u);
  });

  it("lets a program handle KeyboardInterrupt and exit as it chooses", async () => {
    interruptAfter("ready");
    expect(await guest.run("import time\ntry:\n    print('ready', flush=True)\n    end = time.monotonic() + 20\n    while time.monotonic() < end:\n        pass\nexcept KeyboardInterrupt:\n    print('handled')\n    raise SystemExit(3)\n"))
      .toEqual({ status: 3, stdout: "ready\nhandled\n", stderr: "" });
  });

  it("ends time.sleep at once, not when the time is up", async () => {
    interruptAfter("ready");
    const began = performance.now();
    const result = await guest.run("import time\nprint('ready', flush=True)\ntime.sleep(60)\nprint('not reached')\n");
    expect(performance.now() - began).toBeLessThan(10_000);
    expect(result).toMatchObject({ status: "SIGINT", stdout: "ready\n" });
    // CPython 3.14.4 prints exactly this when SIGINT arrives during the same sleep; no frame of the replacement or of
    // Pyodide's JavaScript appears.
    expect(result.stderr).toBe('Traceback (most recent call last):\n  File "/workspace/program.py", line 3, in <module>\n    time.sleep(60)\n    ~~~~~~~~~~^^^^\nKeyboardInterrupt\n');
  });

  it("sleeps for as long as asked when nothing interrupts it, with CPython's checks of the argument", async () => {
    expect(await guest.run("import time\nstart = time.monotonic()\ntime.sleep(0.05)\nprint(time.monotonic() - start >= 0.045, time.sleep.__name__)\n")).toEqual({ status: 0, stdout: "True sleep\n", stderr: "" });
  });

  it("falls back to Pyodide's own sleep where Python cannot wait for JavaScript", () => {
    const seen: unknown = guest.py.runPython("import json, time\nfrom pyodide.ffi import can_run_sync\nstart = time.monotonic()\ntime.sleep(0.02)\njson.dumps([can_run_sync(), time.monotonic() - start >= 0.015])");
    expect(seen).toBe("[false, true]");
  });

  it("interrupts a read of standard input that the signal ended with EINTR", async () => {
    guest.stdio.files.read = () => { guest.interrupts[0] = 2; throw new LinuxError(4); };
    const result = await guest.run("import sys\nsys.stdin.readline()\nprint('not reached')\n");
    expect(result).toMatchObject({ status: "SIGINT", stdout: "" });
    expect(result.stderr).toMatch(/line 2, in <module>\n[\s\S]*KeyboardInterrupt\n$/u);
  });

  it("retries a read that another signal ended with EINTR, as CPython does", async () => {
    let first = true;
    guest.stdio.files.read = (fd, count) => {
      if (first) { first = false; throw new LinuxError(4); }
      return original.read(fd, count);
    };
    expect(await guest.run("import sys\nprint(sys.stdin.readline().strip())\n", { stdin: "after the signal\n" })).toEqual({ status: 0, stdout: "after the signal\n", stderr: "" });
  });

  it("interrupts oxidevm.run while it waits for a native program, and otherwise reports the EINTR", async () => {
    const files = guest.process.host.files;
    const read = files.read;
    try {
      files.read = () => Promise.reject(new LinuxError(4));
      const unexplained = await guest.run("import oxidevm\ntry:\n    oxidevm.run(['/bin/sleep', '100'], timeout=60)\nexcept Exception as error:\n    print(type(error).__name__, getattr(error, 'code', None))\n");
      expect(unexplained).toEqual({ status: 0, stdout: "JsException EINTR\n", stderr: "" });
      files.read = () => { guest.interrupts[0] = 2; return Promise.reject(new LinuxError(4)); };
      const result = await guest.run("import oxidevm\noxidevm.run(['/bin/sleep', '100'], timeout=60)\nprint('not reached')\n");
      expect(result).toMatchObject({ status: "SIGINT", stdout: "" });
      expect(result.stderr).toMatch(/File "\/workspace\/program\.py", line 2, in <module>[\s\S]*KeyboardInterrupt\n$/u);
    } finally {
      files.read = read;
    }
  });

  it("interrupts a socket that waits for its peer, and otherwise reports InterruptedError", async () => {
    guest.sockets.listen("unix:/workspace/_oxidevm/silent.sock", () => undefined);
    const sockets = guest.sockets.sockets;
    const read = sockets.read;
    const program = "import oxidevm\nconnection = oxidevm.connect_unix('/workspace/_oxidevm/silent.sock')\ntry:\n    connection.recv(10)\nexcept InterruptedError as error:\n    print('InterruptedError', error.errno)\n";
    try {
      sockets.read = () => Promise.reject(new LinuxError(4));
      expect(await guest.run(program)).toMatchObject({ status: 0, stdout: "InterruptedError 27\n" });
      sockets.read = () => { guest.interrupts[0] = 2; return Promise.reject(new LinuxError(4)); };
      const result = await guest.run(program);
      expect(result).toMatchObject({ status: "SIGINT", stdout: "" });
      expect(result.stderr).toMatch(/line 4, in <module>[\s\S]*KeyboardInterrupt\n$/u);
    } finally {
      sockets.read = read;
    }
  });

  it("raises a Ctrl+C that arrived while a socket call succeeded once the call returns", async () => {
    guest.sockets.listen("unix:/workspace/_oxidevm/answers.sock", peer => { peer.write("answer"); });
    const sockets = guest.sockets.sockets;
    const read = sockets.read;
    try {
      sockets.read = async (fd, count, options) => { const bytes = await read(fd, count, options); guest.interrupts[0] = 2; return bytes; };
      const result = await guest.run("import oxidevm\nconnection = oxidevm.connect_unix('/workspace/_oxidevm/answers.sock')\nprint(connection.recv(10))\n");
      expect(result).toMatchObject({ status: "SIGINT", stdout: "" });
      expect(result.stderr).toMatch(/line 3, in <module>[\s\S]*KeyboardInterrupt\n$/u);
    } finally {
      sockets.read = read;
    }
  });

  it("raises a Ctrl+C that arrived during any other call of the bridge once the call returns", async () => {
    guest.sockets.listen("unix:/workspace/_oxidevm/sink.sock", () => undefined);
    const sockets = guest.sockets.sockets;
    const saved = { connect: sockets.connect, write: sockets.write, close: sockets.close };
    const program = "import oxidevm\nconnection = oxidevm.connect_unix('/workspace/_oxidevm/sink.sock')\nconnection.sendall(b'data')\nconnection.close()\nprint('not reached')\n";
    try {
      const cases = [
        ["connect", 2, () => { sockets.connect = async (fd, address, options) => { await saved.connect(fd, address, options); guest.interrupts[0] = 2; }; }],
        ["send", 3, () => { sockets.write = async (fd, bytes, options) => { const written = await saved.write(fd, bytes, options); guest.interrupts[0] = 2; return written; }; }],
        ["close", 4, () => { sockets.close = async fd => { await saved.close(fd); guest.interrupts[0] = 2; }; }],
      ] as const;
      for (const [name, line, interrupting] of cases) {
        Object.assign(sockets, saved);
        interrupting();
        const result = await guest.run(program);
        expect(result.status, name).toBe("SIGINT");
        expect(result.stderr, name).toMatch(new RegExp(`line ${String(line)}, in <module>[\\s\\S]*KeyboardInterrupt\\n$`, "u"));
      }
    } finally {
      Object.assign(sockets, saved);
    }
  });

  it("leaves nothing unhandled when Python gives up a wait, as a KeyboardInterrupt before run_sync makes it do", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", listener);
    try {
      // The proxy of the promise stays referenced while the call fails, as in a frame that a KeyboardInterrupt unwinds.
      expect(await guest.run("import _oxidevm_bridge, time\nwaiting = _oxidevm_bridge.recv(12345, 10, 0)\ntime.sleep(0.05)\nprint('gave up')\n")).toEqual({ status: 0, stdout: "gave up\n", stderr: "" });
      await new Promise(resolve => { setTimeout(resolve, 50); });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("returns at once from a sleep of the bridge that is not given a number of milliseconds", async () => {
    expect(await guest.run("import _oxidevm_bridge\nfrom pyodide.ffi import run_sync\nfor value in ('soon', None, -5, float('nan')):\n    run_sync(_oxidevm_bridge.sleep(value))\nprint('returned')\n"))
      .toEqual({ status: 0, stdout: "returned\n", stderr: "" });
  });

  // Last: the interrupted runner does not get to restore the interpreter.
  it("ends by SIGINT too when Ctrl+C arrives while the runner itself finishes, and nothing escapes into Pyodide's event loop", async () => {
    guest.stdio.files.writeAll = (fd, bytes) => {
      if (new TextDecoder().decode(bytes).includes("unfinished")) { guest.interrupts[0] = 2; throw new LinuxError(4); }
      original.writeAll(fd, bytes);
    };
    expect(await guest.run("import sys\nsys.stdout.write('unfinished')\n")).toMatchObject({ status: "SIGINT" });
  });
});
