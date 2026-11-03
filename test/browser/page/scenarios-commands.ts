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

/** A shell on a terminal of its own; `type` sends a line, `send` raw keys (Ctrl+D), `output` collects what the terminal shows. */
async function terminal(vm: UserspaceVM, command: string, args: readonly string[] = []): Promise<{ readonly handle: TerminalHandle; readonly output: Capture; type(line: string): Promise<void>; send(keys: string): Promise<void> }> {
  const handle = await vm.spawn({ command, args, cwd: WORK, terminal: { columns: 100, rows: 30 } });
  const writer = handle.stdin.getWriter();
  return { handle, output: new Capture(handle.output), type: line => writer.write(encoder.encode(`${line}\n`)), send: keys => writer.write(encoder.encode(keys)) };
}

/** How many times `needle` appears in `text`. */
function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
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
  const session = await terminal(context.vm, "/bin/sh", ["-i"]);
  // NO_COLOR: CPython colours tracebacks on a terminal, which would split the texts waited for.
  await session.type("NO_COLOR=1 python3 -q");
  await session.output.waitFor(">>> ");
  // Each result differs from the text typed, which the terminal echoes.
  await session.type("6 * 7");
  await session.output.waitFor("42\r\n>>> ");
  await session.type("for i in range(2):");
  await session.output.waitFor("... ");
  await session.type("    print('row', i + 10)");
  await session.type("");
  await session.output.waitFor("row 11\r\n>>> ");
  await sleep(200);
  await session.handle.interrupt();
  await session.output.waitFor("\r\nKeyboardInterrupt\r\n>>> ");
  await session.type("while True: pass");
  await session.type("");
  await sleep(800);
  await session.handle.interrupt();
  await session.output.waitFor("    while True: pass");
  await session.output.waitFor("KeyboardInterrupt\r\n>>> ");
  await session.type("'af' + 'ter'");
  await session.output.waitFor("'after'\r\n>>> ");
  await session.send("\u0004");
  await session.type(PRINT_STATUS);
  await session.output.waitFor("s2=");
  await sleep(300);
  const shown = session.output.text;
  // A session that reported a KeyboardInterrupt ends killed by SIGINT at Ctrl+D, as CPython 3.14's does.
  check(shown.includes("s2=130") && count(shown, "KeyboardInterrupt") >= 2, `the REPL session: ${JSON.stringify(shown.slice(-900))}`);
  await session.type("NO_COLOR=1 python3 -q -i -c 'x = 5'");
  await session.output.waitFor(">>> ");
  await session.type("x + 37");
  await session.output.waitFor("42\r\n>>> ");
  await session.send("\u0004");
  await session.type(PRINT_STATUS);
  await session.output.waitFor("s2=0");
  await session.type("exit");
  await session.handle.exit;
  return "python3 -q on a terminal: expressions, a block, Ctrl+C at the prompt and in a loop, Ctrl+D ending by SIGINT (130) after an interrupt; python3 -i -c then Ctrl+D with 0";
}

export async function commandModule(context: Context): Promise<string> {
  expectShell(await shell(context.vm, "echo '{\"a\": [1]}' | python3 -m json.tool"), 0, '{\n    "a": [\n        1\n    ]\n}\n', "python3 -m json.tool");
  const missing = await shell(context.vm, "python3 -m nosuchmodule");
  same({ code: missing.code, stderr: missing.stderr }, { code: 1, stderr: "/usr/local/bin/python3: No module named nosuchmodule\n" }, "python3 -m with a missing module");
  await context.vm.workspace.writeText("_oxidevm/mod_here.py", "import sys\nprint(__name__, sys.argv)\n");
  expectShell(await shell(context.vm, "python3 -m mod_here a"), 0, `__main__ ['${WORK}/mod_here.py', 'a']\n`, "python3 -m with a module in the working directory");
  return "python3 -m runs a standard module and one from the working directory, and names a missing one as CPython does";
}

export async function commandLazyImport(context: Context): Promise<string> {
  const began = performance.now();
  expectShell(await shell(context.vm, "python3 -c 'import numpy; print(numpy.__version__)'"), 0, "2.4.6\n", "import numpy without preloading it");
  return `numpy loaded on import by a command whose packages are none, in ${String(Math.round(performance.now() - began))} ms`;
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
  await session.type(`NO_COLOR=1 python3 ${WORK}/sleeper.py`);
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
  // CPython's traceback exactly: no frame of the module's own time.sleep or of Pyodide's JavaScript.
  const traceback = `Traceback (most recent call last):\n  File "${WORK}/sleeper.py", line 3, in <module>\n    time.sleep(600)\n    ~~~~~~~~~~^^^^^\nKeyboardInterrupt\n`;
  check(shown.replaceAll("\r\n", "\n").includes(traceback), `the traceback is not CPython's: ${JSON.stringify(shown.slice(-600))}`);
  return `Ctrl+C ended time.sleep(600) in ${String(took)} ms, with CPython's traceback and status 130`;
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
  ["command: the interactive interpreter on a terminal, and -i", commandRepl],
  ["command: python3 -m", commandModule],
  ["command: a package loads when imported", commandLazyImport],
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
