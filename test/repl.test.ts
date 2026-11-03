import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Worker } from "node:worker_threads";
import { LinuxError } from "@oxidevm/sdk/js-process";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PYTHON_VERSION } from "../src/cli.ts";
import { normalised, oracle, oracleFiles, withoutBuild } from "./support/cpython-oracle.ts";
import type { OracleSession } from "./support/cpython-oracle.ts";
import { startGuest } from "./support/guest-fixture.ts";
import type { GuestFixture, RunResult } from "./support/guest-fixture.ts";

// CPython's basic interactive interpreter against real CPython 3.14 at a terminal (test/fixtures/cpython-cli.json,
// "sessions", recorded by scripts/record-cpython-cli.py with PYTHON_BASIC_REPL=1 and no readline). The VM's PTY works in
// cooked mode: a read of standard input answers one typed line, Ctrl+D at the start of a line is end of input, and Ctrl+C
// sends SIGINT, which the runtime writes into Pyodide's interrupt buffer and which ends a waiting read with EINTR. Here
// the test plays that terminal: it answers each read with the next step, as CPython's recording sent it at a prompt.

const MODULE = { executable: "/usr/local/bin/python3", version: PYTHON_VERSION };
const SETTLE_MS = 300;

/** Writes SIGINT into the buffer from another thread after `afterMs`, while this thread is busy running Python. */
function interruptFromAnotherThread(buffer: Int32Array, afterMs: number): void {
  const worker = new Worker(`const { workerData } = require("node:worker_threads"); setTimeout(() => { Atomics.store(new Int32Array(workerData), 0, 2); }, ${String(afterMs)});`, { eval: true, workerData: buffer.buffer });
  worker.unref();
}

let guest: GuestFixture;
let original: GuestFixture["stdio"]["files"]["read"];

beforeAll(async () => {
  guest = await startGuest();
  original = guest.stdio.files.read;
  for (const [path, text] of oracleFiles()) {
    const real = guest.files.real(path);
    await mkdir(dirname(real), { recursive: true });
    await writeFile(real, text);
  }
}, 120_000);

afterEach(() => { guest.stdio.files.read = original; });

afterAll(async () => {
  await guest.stop();
  await guest.dispose();
});

/** Plays the session's steps as the terminal: one step per read of standard input, then end of input. */
function playTerminal(session: OracleSession): void {
  const steps = [...session.steps];
  guest.stdio.files.read = (_fd, count) => {
    const step = steps.shift();
    if (step === undefined || step.input === "\u0004") return new Uint8Array(0);
    if (step.input === "\u0003") {
      // Ctrl+C at a prompt: SIGINT reaches the buffer and ends the waiting read.
      guest.interrupts[0] = 2;
      throw new LinuxError(4);
    }
    // Ctrl+C typed while this input runs.
    if (steps[0]?.when === "running") {
      steps.shift();
      interruptFromAnotherThread(guest.interrupts, SETTLE_MS);
    }
    return new TextEncoder().encode(step.input).subarray(0, count);
  };
}

function expected(session: OracleSession): RunResult {
  const status = session.exit.kind === "exited" ? session.exit.code : session.exit.signal === "SIGINT" ? "SIGINT" : -1;
  return { status, stdout: normalised(session.stdout, MODULE), stderr: normalised(session.stderr, MODULE) };
}

describe("the interactive interpreter, against CPython 3.14 at a terminal", () => {
  it("covers expressions, blocks, errors, Ctrl+C at a prompt and in a loop, Ctrl+D, -q, - and -i after programs", () => {
    const names = oracle.sessions.map(session => session.name);
    for (const name of ["repl-expressions", "repl-block", "repl-exception", "repl-interrupt-at-prompt", "repl-interrupt-loop", "repl-quiet", "interactive-after-code", "interactive-after-raising-file"]) expect(names).toContain(name);
  });

  for (const session of oracle.sessions) {
    it(`${session.name}: ${JSON.stringify(session.argv.slice(1)).slice(0, 60)}`, async () => {
      playTerminal(session);
      const result = await guest.runCommandLine(session.argv.slice(1), { cwd: oracle.provenance.cwd, terminal: true, argv0: oracle.provenance.argv0, executable: MODULE.executable });
      expect({ ...result, stderr: withoutBuild(result.stderr) }).toEqual(expected(session));
    }, 30_000);
  }
});

describe("the interactive interpreter, where the module differs", () => {
  it("names Pyodide's own build and platform in the banner", async () => {
    playTerminal({ name: "banner", argv: ["python3"], steps: [], stdout: "", stderr: "", exit: { kind: "exited", code: 0 } });
    const result = await guest.runCommandLine([], { terminal: true });
    const version: unknown = guest.py.runPython("import sys\nsys.version");
    expect(result.stderr.split("\n")[0]).toBe(`Python ${String(version)} on emscripten`);
    expect(result.status).toBe(0);
  });

  it("leaves no prompts behind for the next program in the same interpreter", async () => {
    playTerminal({ name: "prompts", argv: ["python3"], steps: [], stdout: "", stderr: "", exit: { kind: "exited", code: 0 } });
    await guest.runCommandLine(["-q"], { terminal: true });
    expect(await guest.runCommandLine(["-c", "import sys\nprint(hasattr(sys, 'ps1'), hasattr(sys, 'ps2'))"])).toEqual({ status: 0, stdout: "False False\n", stderr: "" });
  });

  it("keeps sys.ps1 and sys.ps2 that the program set", async () => {
    playTerminal({ name: "custom", argv: ["python3"], steps: [{ input: "1\n", when: "prompt" }], stdout: "", stderr: "", exit: { kind: "exited", code: 0 } });
    expect(await guest.runCommandLine(["-i", "-c", "import sys\nsys.ps1 = 'py> '"], { terminal: true })).toEqual({ status: 0, stdout: "1\n", stderr: "py> py> \n" });
    guest.py.runPython("import sys\ndel sys.ps1");
  });

  it("runs time.sleep and the bridge's waits from the prompt, as a program does", async () => {
    playTerminal({ name: "sleep", argv: ["python3"], steps: [{ input: "import time; time.sleep(0.01); 'slept'\n", when: "prompt" }], stdout: "", stderr: "", exit: { kind: "exited", code: 0 } });
    expect(await guest.runCommandLine(["-q"], { terminal: true })).toEqual({ status: 0, stdout: "'slept'\n", stderr: ">>> >>> \n" });
  });
});
