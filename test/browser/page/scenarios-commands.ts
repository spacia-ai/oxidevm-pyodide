import type { TerminalHandle, UserspaceVM } from "@oxidevm/sdk";
import type { ModuleCommandsStatus } from "@oxidevm/sdk/wasm";
import { Capture, check, decoder, encoder, field, native, run, same, sleep } from "./support.ts";
import type { Context } from "./support.ts";

// The module's python3 and python commands (engine ADR 0027): programs in the VM run them from the shell like any other
// program. These need the SDK runtime that serves module commands and delivers signals to a module; main.ts wires
// `enableModuleCommands` into the context.

/** What the scenarios use of the handle that `enableModuleCommands` returns. */
export interface EnabledCommands {
  status(): Promise<ModuleCommandsStatus>;
  disable(): Promise<void>;
}

/** What the page gives these scenarios: `enableModuleCommands` of @oxidevm/sdk/wasm for this module. */
export interface CommandSwitch {
  /** Turns python and python3 on in the VM, with no packages to load; resolves to the handle that reports and turns them off. */
  enable(vm: UserspaceVM): Promise<EnabledCommands>;
}

const WORK = "/workspace/_oxidevm";

/**
 * A shell command that prints the status of the previous one as `s2=<status>`. A terminal echoes what is typed, so the
 * marker must not appear in the typed text: `$((1+1))` becomes 2 only in the output.
 */
const PRINT_STATUS = 'echo "s$((1+1))=$?"';

/** What the module says, after its argv[0], when there is no program and standard input is a terminal. */
const REPL_REFUSAL = "the interactive interpreter is not supported yet; use FILE, -c CODE or -";

interface Shell {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a shell command line in the VM, as a person would type it. */
async function shell(vm: UserspaceVM, line: string, options: { readonly cwd?: string; readonly stdin?: string } = {}): Promise<Shell> {
  const result = await vm.exec({ command: "/bin/sh", args: ["-c", line], cwd: options.cwd ?? WORK, ...(options.stdin === undefined ? {} : { stdin: encoder.encode(options.stdin) }) });
  return { code: result.exit.kind === "exited" ? result.exit.code : 128 + result.exit.signalNumber, stdout: decoder.decode(result.stdout), stderr: decoder.decode(result.stderr) };
}

function expectShell(result: Shell, code: number, stdout: string, what: string): void {
  same({ code: result.code, stdout: result.stdout }, { code, stdout }, `${what} (stderr: ${result.stderr.slice(-600)})`);
}

/** A shell on a terminal of its own; `type` sends a line, `output` collects what the terminal shows. */
async function terminal(vm: UserspaceVM, command: string, args: readonly string[] = []): Promise<{ readonly handle: TerminalHandle; readonly output: Capture; type(line: string): Promise<void> }> {
  const handle = await vm.spawn({ command, args, cwd: WORK, terminal: { columns: 100, rows: 30 } });
  const writer = handle.stdin.getWriter();
  return { handle, output: new Capture(handle.output), type: line => writer.write(encoder.encode(`${line}\n`)) };
}

function switchOf(context: Context): CommandSwitch {
  const { commands } = context;
  if (commands === undefined) throw new Error("the page did not wire enableModuleCommands into the context");
  return commands;
}

function enabledOf(context: Context): EnabledCommands {
  const enabled = context.enabledCommands;
  if (enabled === undefined) throw new Error("the commands were not enabled");
  return enabled;
}

/** The server's log from entry `since` on (test/browser/harness.ts): every path the page and its workers requested. */
async function requestLog(since: number): Promise<{ readonly next: number; readonly paths: readonly string[] }> {
  const value: unknown = await (await fetch(`/__requests?since=${String(since)}`)).json();
  const next = field(value, "next"), listed = field(value, "paths");
  const paths = Array.isArray(listed) ? Array.from<unknown>(listed).filter((path): path is string => typeof path === "string") : [];
  if (typeof next !== "number" || !Array.isArray(listed) || paths.length !== listed.length) throw new Error("the server's request log has the wrong fields");
  return { next, paths };
}

/** The paths at which the page fetches the module's pinned files: its adapter and every artifact. */
function pinnedPaths(context: Context): ReadonlySet<string> {
  const { pins } = context.pyodide;
  return new Set([pins.adapter, ...Object.values(pins.artifacts)].map(pin => new URL(pin.url, location.href).pathname));
}

export async function commandStatus(context: Context): Promise<string> {
  same(await enabledOf(context).status(), { enabled: true, skipped: [] }, "status() of the enable");
  return "status() reports the commands on, with no command skipped";
}

/**
 * Turning the commands on fetched and checked the module's files once; a run uses those copies. The server's log shows
 * what each run fetched, and the times are for the record (diagnostic only: one machine, wall time in the page).
 */
export async function commandVerifiedCopies(context: Context): Promise<string> {
  const pinned = pinnedPaths(context);
  const earlier = await requestLog(0);
  const fetchedEarlier = earlier.paths.filter(path => pinned.has(path)).length;
  check(fetchedEarlier > 0, "the server's log names no pinned file of the module, so it cannot show what a run fetched");
  let since = earlier.next;
  const runs: string[] = [];
  for (const which of ["first", "second"]) {
    const began = performance.now();
    const result = await shell(context.vm, "python3 -c 'print(1)'");
    const took = Math.round(performance.now() - began);
    expectShell(result, 0, "1\n", `the ${which} python3 -c 'print(1)'`);
    const log = await requestLog(since);
    since = log.next;
    const fetched = log.paths.filter(path => pinned.has(path));
    check(fetched.length === 0, `the ${which} run (${String(took)} ms) fetched pinned files of the module again: ${fetched.join(", ")}`);
    runs.push(`${which} run ${String(took)} ms, ${String(log.paths.length)} request${log.paths.length === 1 ? "" : "s"}, none for a pinned file`);
  }
  const baseline = performance.now();
  expectShell(await shell(context.vm, ":"), 0, "", "the shell alone");
  const shellAlone = Math.round(performance.now() - baseline);
  return `python3 -c 'print(1)' through /bin/sh -c: ${runs.join("; ")}; /bin/sh -c : alone ${String(shellAlone)} ms (the log holds ${String(fetchedEarlier)} earlier fetches of the ${String(pinned.size)} pinned files, from turning the commands on and from application starts)`;
}

export async function commandCode(context: Context): Promise<string> {
  const result = await shell(context.vm, `python3 -c 'import sys; print(sys.argv, sys.executable, sys.orig_argv)' one 'two words'`);
  expectShell(result, 0, "['-c', 'one', 'two words'] /usr/local/bin/python3 ['python3', '-c', 'import sys; print(sys.argv, sys.executable, sys.orig_argv)', 'one', 'two words']\n", "python3 -c with arguments");
  return "python3 -c ran with CPython's sys.argv, sys.executable and sys.orig_argv";
}

export async function commandAlias(context: Context): Promise<string> {
  const result = await shell(context.vm, "python -c 'import sys; print(sys.executable, sys.orig_argv[0], sys.version_info[:2])'");
  expectShell(result, 0, "/usr/local/bin/python python (3, 14)\n", "python, the other name");
  return "python is the same module under its own name";
}

export async function commandFile(context: Context): Promise<string> {
  await context.vm.workspace.writeText("_oxidevm/command-args.py", "import os, sys\nprint(sys.argv, __file__, sys.path[0], os.getcwd())\nsys.exit(len(sys.argv))\n");
  const result = await shell(context.vm, "python3 command-args.py x 'y z'");
  expectShell(result, 3, `['command-args.py', 'x', 'y z'] ${WORK}/command-args.py ${WORK} ${WORK}\n`, "python3 FILE with arguments");
  return "a file with arguments, its exit status reaching the shell";
}

export async function commandPipe(context: Context): Promise<string> {
  const piped = await shell(context.vm, "echo 'print(2 + 2)' | python3");
  expectShell(piped, 0, "4\n", "a program piped to python3");
  const dash = await shell(context.vm, "printf 'import sys\\nprint(sys.argv, sys.stdin.isatty(), sys.stdin.read())\\n' | python3 - a b");
  expectShell(dash, 0, "['-', 'a', 'b'] False \n", "python3 - with arguments");
  const input = await shell(context.vm, "python3 -c 'import sys; print(sys.stdin.read().upper())'", { stdin: "from the pipe\n" });
  expectShell(input, 0, "FROM THE PIPE\n\n", "standard input of python3 -c");
  return "programs on standard input, with and without -, and -c reading standard input";
}

export async function commandRepl(context: Context): Promise<string> {
  // Started directly, argv[0] is the path; the terminal turns the message's newline into CR LF.
  const direct = await terminal(context.vm, "/usr/local/bin/python3");
  const exit = await direct.handle.exit;
  await direct.output.done;
  same({ exit, shown: direct.output.text }, { exit: { kind: "exited", code: 2 }, shown: `/usr/local/bin/python3: ${REPL_REFUSAL}\r\n` }, "python3 started on a terminal");
  // Typed in a shell, argv[0] is the name as typed.
  const session = await terminal(context.vm, "/bin/sh", ["-i"]);
  await session.type("python3");
  await session.output.waitFor(REPL_REFUSAL);
  await session.type(PRINT_STATUS);
  await session.output.waitFor("s2=");
  await sleep(300);
  const shown = session.output.text;
  await session.type("exit");
  await session.handle.exit;
  check(shown.includes(`\npython3: ${REPL_REFUSAL}\r\n`) && shown.includes("s2=2\r\n"), `python3 typed in a shell on a terminal: ${JSON.stringify(shown.slice(-600))}`);
  return "with a terminal on standard input and no program, python3 started directly and python3 typed in a shell stop with status 2 and the exact message";
}

export async function commandPlaces(context: Context): Promise<string> {
  expectShell(await shell(context.vm, "python3 -c 'import os; print(os.getcwd())'", { cwd: "/tmp" }), 0, "/tmp\n", "python3 from /tmp");
  const root = await shell(context.vm, "python3 -c pass", { cwd: "/" });
  same({ code: root.code, stderr: root.stderr }, { code: 2, stderr: "python3: cannot run in '/': this Python sees the VM's files only under /workspace, /tmp and $HOME\n" }, "python3 from /");
  return "runs from /tmp; refuses / with status 2 before Python loads";
}

export async function commandShebang(context: Context): Promise<string> {
  const { vm } = context;
  await vm.workspace.writeText("_oxidevm/through-env.py", "#!/usr/bin/env python3\nimport sys\nprint('env', sys.argv[1:], sys.executable)\n");
  await vm.workspace.writeText("_oxidevm/direct.py", "#!/usr/local/bin/python3\nimport sys\nprint('direct', sys.argv[1:], sys.executable)\n");
  same((await native(vm, "/bin/chmod", ["755", `${WORK}/through-env.py`, `${WORK}/direct.py`])).code, 0, "chmod");
  expectShell(await shell(vm, "./through-env.py a b"), 0, "env ['a', 'b'] /usr/local/bin/python3\n", "#!/usr/bin/env python3");
  expectShell(await shell(vm, "./direct.py c"), 0, "direct ['c'] /usr/local/bin/python3\n", "#!/usr/local/bin/python3");
  return "scripts start through #!/usr/bin/env python3 and #!/usr/local/bin/python3";
}

export async function commandBridgeHidden(context: Context): Promise<string> {
  const refused = await shell(context.vm, "python3 -c 'import js'");
  check(refused.code === 1 && refused.stderr.includes("ModuleNotFoundError: No module named 'js'"), `import js as a command: ${JSON.stringify(refused)}`);
  const others = await shell(context.vm, "python3 -c \"import importlib\nfor name in ('pyodide_js', 'pyodide.ffi', 'pyodide.http', 'pyodide.code'):\n    try:\n        importlib.import_module(name)\n        print(name, 'imported')\n    except ImportError:\n        print(name, 'refused')\"");
  expectShell(others, 0, "pyodide_js refused\npyodide.ffi refused\npyodide.http refused\npyodide.code refused\n", "the rest of the bridge as a command");
  const application = await run(context, "import js\nprint('application', type(js).__name__)\n", { name: "bridge", packages: [] });
  check(application.exit.kind === "exited" && application.exit.code === 0 && application.stdout.startsWith("application "), `import js when the application starts the module: ${application.stderr.slice(-400)}`);
  return "the JavaScript bridge is hidden from commands and kept for the application";
}

export async function commandInterrupt(context: Context): Promise<string> {
  await context.vm.workspace.writeText("_oxidevm/spin.py", "import atexit\natexit.register(print, 'atexit ran')\nprint('ready', flush=True)\nwhile True:\n    pass\n");
  const session = await terminal(context.vm, "/bin/sh", ["-i"]);
  await session.type(`for i in 1 2 3; do python3 ${WORK}/spin.py; echo "after $i"; done`);
  await session.output.waitFor("ready");
  await sleep(300);
  await session.handle.interrupt();
  await session.output.waitFor("atexit ran");
  await session.type(PRINT_STATUS);
  await session.output.waitFor("s2=");
  await sleep(300);
  const shown = session.output.text;
  await session.type("exit");
  await session.handle.exit;
  check(shown.includes("KeyboardInterrupt"), `no traceback: ${JSON.stringify(shown.slice(-800))}`);
  // The typed loop says "after $i"; only a loop that went on prints "after 1".
  check(!shown.includes("after 1"), `the loop went on after Ctrl+C: ${JSON.stringify(shown.slice(-800))}`);
  check(shown.includes("s2=130"), `the shell did not see a death by SIGINT: ${JSON.stringify(shown.slice(-800))}`);
  return "Ctrl+C on while True printed the traceback, ran atexit, ended python3 by SIGINT (130) and stopped the shell's loop";
}

export async function commandSleepInterrupt(context: Context): Promise<string> {
  // In a file, so that the terminal's echo of the typed line cannot contain what the program prints.
  await context.vm.workspace.writeText("_oxidevm/sleeper.py", "import time\nprint('asleep', flush=True)\ntime.sleep(600)\n");
  const session = await terminal(context.vm, "/bin/sh", ["-i"]);
  // On a line of its own: an interactive shell drops the rest of a line once a Ctrl+C has killed its command.
  await session.type(`python3 ${WORK}/sleeper.py`);
  await session.output.waitFor("asleep");
  await sleep(300);
  const pressed = performance.now();
  await session.handle.interrupt();
  await session.output.waitFor("KeyboardInterrupt");
  const took = Math.round(performance.now() - pressed);
  await session.type(PRINT_STATUS);
  await session.output.waitFor("s2=");
  await sleep(300);
  const shown = session.output.text;
  await session.type("exit");
  await session.handle.exit;
  check(shown.includes("s2=130") && shown.includes("KeyboardInterrupt") && took < 10_000, `time.sleep did not end by SIGINT at once (${String(took)} ms): ${JSON.stringify(shown.slice(-600))}`);
  return `Ctrl+C ended time.sleep(600) in ${String(took)} ms, with a traceback and status 130`;
}

export async function commandDisabled(context: Context): Promise<string> {
  const { vm } = context;
  const enabled = enabledOf(context);
  await enabled.disable();
  same(await enabled.status(), { enabled: false, skipped: [] }, "status() after disable()");
  const stub = await shell(vm, "test -e /usr/local/bin/python3 || test -e /usr/local/bin/python; echo $?");
  same(stub.stdout, "1\n", "the stubs after disable()");
  // The shell looks the names up again. python3 is the image's own: the harness needs an image with /usr/bin/python3.
  expectShell(await shell(vm, "python3 -c 'import sys; print(sys.executable)'"), 0, "/usr/bin/python3\n", "python3 after disable()");
  // python is the image's own when it has one on PATH, and otherwise not found.
  const own = (await shell(vm, 'IFS=:; for dir in $PATH; do if [ -x "$dir/python" ]; then echo "$dir/python"; break; fi; done')).stdout;
  const alias = await shell(vm, "python -c 'import sys; print(sys.executable)'");
  if (own === "") check(alias.code === 127 && alias.stdout === "" && alias.stderr.includes("python: not found"), `python after disable(), which the image does not have: ${JSON.stringify(alias)}`);
  else expectShell(alias, 0, own, "python after disable()");
  return `after disable() status() reports the commands off and the stubs are gone: python3 is the image's /usr/bin/python3 again, python is ${own === "" ? "not found (127), as the image has none" : `the image's ${own.trim()}`}`;
}

/** In the order they run: enabling comes first (scenarios.ts), turning the commands off last. */
export const COMMAND_SCENARIOS: readonly (readonly [name: string, run: (context: Context) => Promise<string>])[] = [
  ["command: status() of the enable", commandStatus],
  ["command: a first and a second run use the checked copies: no fetch of the module's files (server log), timed", commandVerifiedCopies],
  ["command: python3 -c with arguments", commandCode],
  ["command: python, the other name", commandAlias],
  ["command: python3 FILE with arguments and its status", commandFile],
  ["command: programs on standard input, with and without -", commandPipe],
  ["command: no program on a terminal is refused (no REPL yet)", commandRepl],
  ["command: runs from /tmp, refuses / before Python loads", commandPlaces],
  ["command: shebang scripts", commandShebang],
  ["command: the JavaScript bridge is hidden from commands only", commandBridgeHidden],
  ["command: Ctrl+C on while True ends python3 by SIGINT and stops a shell loop", commandInterrupt],
  ["command: Ctrl+C ends time.sleep at once", commandSleepInterrupt],
  ["command: after disable(): off, and the shell finds the image's own program or none (127)", commandDisabled],
];

/** Turns the commands on for the scenarios above; `switchOf` explains a page that cannot. */
export async function enableCommands(context: Context): Promise<EnabledCommands> {
  return switchOf(context).enable(context.vm);
}
