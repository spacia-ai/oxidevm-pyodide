import type { ProcessExit } from "@oxidevm/sdk";
import { spawnModule } from "@oxidevm/sdk/wasm";
import { check, describeExit, expectStatus, failureOf, field, native, run, same, sleep, start } from "./support.ts";
import type { Context } from "./support.ts";

// Scenarios about the module as a process: what it computes, how it ends, and how it reaches native Linux programs.

function parsed(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}

/** Starts the module with exactly these arguments (no program written first) and returns how it ended and what it said. */
async function bare(context: Context, args: readonly string[]): Promise<{ readonly exit: ProcessExit; readonly stderr: string }> {
  const process = await spawnModule(context.vm, context.pyodide, { args, options: { packages: [] } });
  const [exit, stderr] = await Promise.all([process.exit, new Response(process.stderr).text()]);
  return { exit, stderr };
}

export async function pandas(context: Context): Promise<string> {
  const result = await run(context, `import numpy as np
import pandas as pd
print("numpy", np.__version__)
print("pandas", pd.__version__)
frame = pd.DataFrame({"country": ["NL", "DE", "NL", "FR"], "total": [149, 119, 150, 99]})
summary = frame.groupby("country", as_index=False).agg(orders=("total", "count"), revenue=("total", "sum"))
print(summary.sort_values("revenue", ascending=False).to_csv(index=False), end="")
print("mean", float(frame["total"].mean()))
`, { name: "pandas" });
  expectStatus(result, 0, "pandas run");
  same(result.stdout, "numpy 2.4.6\npandas 3.0.2\ncountry,orders,revenue\nNL,2,299\nDE,1,119\nFR,1,99\nmean 129.25\n", "what Python printed");
  same(result.stderr, "", "standard error");
  return `numpy 2.4.6 and pandas 3.0.2 ran in ${String(result.ms)} ms (module start, imports and run, default packages)`;
}

export async function packagesOption(context: Context): Promise<string> {
  const result = await run(context, `import numpy
print("numpy", numpy.__version__)
try:
    import pandas
    print("pandas imported")
except ModuleNotFoundError as error:
    print("no", error.name)
`, { name: "packages", packages: ["numpy"] });
  expectStatus(result, 0, "numpy-only run");
  same(result.stdout, "numpy 2.4.6\nno pandas\n", "what Python printed with only numpy");
  const refused = await failureOf(spawnModule(context.vm, context.pyodide, { args: ["/workspace/_oxidevm/packages.py"], options: { packages: ["scipy"] } }));
  same([refused.code, refused.reason], ["INVALID_ARGUMENT", "wasm-module-options"], "an unknown package");
  return `only numpy loaded in ${String(result.ms)} ms; an unknown package is refused by the SDK (${refused.message})`;
}

export async function standardStreams(context: Context): Promise<string> {
  const running = await start(context, `import sys
lines = [line.rstrip("\\n") for line in sys.stdin]
for line in lines:
    print(line.upper())
print(len(lines), "lines", file=sys.stderr)
sys.exit(3)
`, { name: "streams", packages: [], keepInput: true });
  await running.send("alpha\nbeta é\n");
  const result = await running.finished;
  expectStatus(result, 3, "streams run");
  same([result.stdout, result.stderr], ["ALPHA\nBETA É\n", "2 lines\n"], "standard output and standard error");
  return "stdin reached Python, stdout and stderr stayed apart, and the status came back";
}

export async function identity(context: Context): Promise<string> {
  const running = await start(context, `import json, os
print(json.dumps({"pid": os.getpid(), "uid": os.getuid(), "gid": os.getgid(), "euid": os.geteuid(), "cwd": os.getcwd(), "home": os.environ["HOME"], "greeting": os.environ.get("GREETING")}))
`, { name: "identity", packages: [], env: { GREETING: "hello from the process" } });
  const result = await running.finished;
  expectStatus(result, 0, "identity run");
  const uid = (await native(context.vm, "/bin/id", ["-u"])).stdout.trim(), gid = (await native(context.vm, "/bin/id", ["-g"])).stdout.trim();
  same(parsed(result.stdout), { cwd: "/workspace", euid: Number(uid), gid: Number(gid), greeting: "hello from the process", home: "/workspace", pid: running.process.pid, uid: Number(uid) }, "what Python reports");
  return `os.getpid() is the module process's id ${String(running.process.pid)}; uid ${uid}, gid ${gid}`;
}

export async function exitStatuses(context: Context): Promise<string> {
  const cases: readonly (readonly [string, string, number, RegExp | undefined])[] = [
    ["plain", "print('fine')", 0, undefined],
    ["traceback", "def f():\n    raise RuntimeError('broken')\nf()\n", 1, /Traceback \(most recent call last\):[\s\S]*line 3, in <module>[\s\S]*RuntimeError: broken/u],
    ["exit42", "import sys\nsys.exit(42)", 42, undefined],
    ["exit200", "import sys\nsys.exit(200)", 119, undefined],
    ["exitText", "import sys\nsys.exit('giving up')", 1, /giving up/u],
    ["syntax", "def (:\n", 1, /SyntaxError/u],
  ];
  const seen: string[] = [];
  for (const [name, source, status, pattern] of cases) {
    const result = await run(context, source, { name: `exit-${name}`, packages: [] });
    expectStatus(result, status, name);
    if (pattern !== undefined) check(pattern.test(result.stderr), `${name}: standard error was ${JSON.stringify(result.stderr)}`);
    check(!/_pyodide|oxidevm-runner/u.test(result.stderr), `${name}: the runner's own frames leaked into ${result.stderr}`);
    seen.push(`${name}=${String(status)}`);
  }
  const usage = await bare(context, []);
  same(describeExit(usage.exit), "exit 2", "no program named");
  check(usage.stderr.includes("usage: pyodide <script.py>"), `the usage text was ${JSON.stringify(usage.stderr)}`);
  const absent = await bare(context, ["/workspace/_oxidevm/no-such-program.py"]);
  same(describeExit(absent.exit), "exit 2", "a program that does not exist");
  check(absent.stderr.includes("can't open file '/workspace/_oxidevm/no-such-program.py': [Errno 2] No such file or directory"), `the message was ${JSON.stringify(absent.stderr)}`);
  return `${seen.join(" ")} usage=2 missing=2`;
}

export async function tamperedArtifact(context: Context): Promise<string> {
  await fetch("/__tamper/on");
  try {
    const result = await run(context, "print('this must never run')\n", { name: "tampered", packages: [] });
    check(result.exit.kind === "exited" && result.exit.code === 121, `expected exit 121 but got ${describeExit(result.exit)}; stderr: ${result.stderr}`);
    check(result.stdout === "", `module code ran: ${result.stdout}`);
    const report: unknown = parsed(result.stderr.trim().split("\n").at(-1) ?? "");
    same([field(report, "oxidevm"), field(report, "kind")], ["error", "integrity"], "the runner's report");
    return `exit 121, ${String(field(report, "message"))}`;
  } finally {
    await fetch("/__tamper/off");
  }
}

export async function nativeRun(context: Context): Promise<string> {
  const result = await run(context, `import json, time
import oxidevm
import pandas as pd

out = {}
uname = oxidevm.run(["/bin/uname", "-m"])
out["uname"] = [uname.stdout.strip(), uname.returncode, uname.pid > 1]
out["cat"] = oxidevm.run(["/bin/cat"], input="x" * 200000).stdout == "x" * 200000
failed = oxidevm.run(["/bin/sh", "-c", "printf out; printf err >&2; exit 7"], check=False)
out["failed"] = [failed.stdout, failed.stderr, failed.returncode]
try:
    oxidevm.run(["/bin/sh", "-c", "echo oops >&2; exit 9"])
    out["check"] = "accepted"
except RuntimeError as error:
    out["check"] = str(error)
began = time.time()
try:
    oxidevm.run(["/bin/sh", "-c", "while :; do :; done"], timeout=0.5)
    out["timeout"] = "accepted"
except Exception as error:
    out["timeout"] = "timed out" in str(error)
out["timeout_took_under_10s"] = time.time() - began < 10
try:
    oxidevm.run(["/bin/head", "-c", "1100000", "/dev/zero"], timeout=30)
    out["limit"] = "accepted"
except Exception as error:
    out["limit"] = "output limit" in str(error)
orders = pd.DataFrame({"order_id": list(range(1, 9)), "total": [149, 119, 99, 150, 129, 120, 90, 150]})
orders.to_csv("/workspace/_oxidevm/orders.csv", index=False)
oxidevm.run(["/bin/gzip", "-k", "-f", "/workspace/_oxidevm/orders.csv"])
back = pd.read_csv("/workspace/_oxidevm/orders.csv.gz")
out["gzip"] = [len(back), int(back["total"].sum())]
print(json.dumps(out, sort_keys=True))
`, { name: "native-run" });
  expectStatus(result, 0, "oxidevm.run");
  same(parsed(result.stdout), {
    cat: true, check: "Native command exited 9: oops\n", failed: ["out", "err", 7], gzip: [8, 1006], limit: true, timeout: true, timeout_took_under_10s: true, uname: ["x86_64", 0, true],
  }, "what oxidevm.run did");
  const listing = await native(context.vm, "/bin/ls", ["/workspace/_oxidevm/orders.csv.gz"]);
  same(listing.code, 0, "the file the native gzip wrote is there for Linux too");
  return `uname, input, exit status, check, timeout, output limit and a gzip pipeline between pandas and native gzip: ${String(result.ms)} ms`;
}

export async function cancellation(context: Context): Promise<string> {
  const { vm } = context;
  await vm.workspace.remove("_oxidevm/cancel.pid").catch(() => undefined);
  const report: string[] = [];
  for (const scope of ["process-group", "process"] as const) {
    await vm.workspace.remove("_oxidevm/cancel.pid").catch(() => undefined);
    const running = await start(context, 'import oxidevm\noxidevm.run(["/bin/sh", "-c", "echo $$ > /workspace/_oxidevm/cancel.pid; while :; do :; done"], timeout=60)\n', { name: `cancel-${scope}`, packages: [] });
    let pid = "";
    for (let attempt = 0; attempt < 600 && !/^\d+$/u.test(pid); attempt += 1) {
      pid = (await vm.workspace.readText("_oxidevm/cancel.pid").catch(() => "")).trim();
      if (!/^\d+$/u.test(pid)) await sleep(100);
    }
    check(/^\d+$/u.test(pid), "the native child did not start");
    const killedAt = performance.now();
    await running.process.kill("SIGKILL", { scope });
    const result = await running.finished;
    const took = Math.round(performance.now() - killedAt);
    check(took < 5000, `cancelling with scope ${scope} took ${String(took)} ms`);
    check(result.exit.kind === "signaled" && result.exit.signalNumber === 9, `the module ended with ${describeExit(result.exit)}`);
    const alive = (await native(vm, "/bin/kill", ["-0", pid])).code === 0;
    if (scope === "process-group") check(!alive, "the native child survived the cancellation of the process group");
    // Killing the process alone is reported, not required: it shows what the engine does with the child.
    report.push(`${scope}: module ended in ${String(took)} ms, native child ${alive ? "still running" : "gone"}`);
    if (alive) await native(vm, "/bin/kill", ["-9", pid]);
  }
  const recovered = await run(context, 'print("recovered")\n', { name: "after-cancel", packages: [] });
  expectStatus(recovered, 0, "run after cancellation");
  return `${report.join("; ")}; the next run works`;
}

/** Not a check: the times a person waits for, for the record. The scenario fails only if a run fails. */
export async function startupTiming(context: Context): Promise<string> {
  const variants: readonly (readonly [label: string, source: string, packages?: readonly string[]])[] = [
    ["interpreter only", "print('ready')\n", []],
    ["numpy", "import numpy\nprint('ready')\n", ["numpy"]],
    ["pandas and matplotlib (the default)", "import os\nos.environ['MPLCONFIGDIR'] = '/workspace/_oxidevm/matplotlib'\nimport pandas, matplotlib.pyplot\nprint('ready')\n"],
  ];
  const rows: string[] = [];
  for (const [label, source, packages] of variants) {
    const times: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await run(context, source, { name: "timing", ...(packages === undefined ? {} : { packages }) });
      expectStatus(result, 0, label);
      times.push(result.ms);
    }
    rows.push(`${label}: ${times.join(", ")} ms`);
  }
  return `from the start of the module process to its exit, three runs each (diagnostic only): ${rows.join("; ")}`;
}
