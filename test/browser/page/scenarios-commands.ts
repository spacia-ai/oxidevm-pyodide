import type { TerminalHandle, UserspaceVM } from "@oxidevm/sdk";
import { Capture, check, decoder, encoder, native, run, same, sleep } from "./support.ts";
import type { Context } from "./support.ts";

// The module's python3 and python commands (engine ADR 0027): programs in the VM run them from the shell like any other
// program. These need the SDK runtime that serves module commands and delivers signals to a module; main.ts wires
// `enableModuleCommands` into the context.

/** What the page gives these scenarios: `enableModuleCommands` of @oxidevm/sdk/wasm for this module. */
export interface CommandSwitch {
  /** Turns python and python3 on in the VM, with no packages to load; resolves to the handle that turns them off. */
  enable(vm: UserspaceVM): Promise<{ disable(): Promise<void> }>;
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
  const session = await terminal(context.vm, "/usr/local/bin/python3");
  const exit = await session.handle.exit;
  await session.output.done;
  check(session.output.text.includes("python3: the interactive interpreter is not supported yet; use FILE, -c CODE or -") || session.output.text.includes("/usr/local/bin/python3: the interactive interpreter"), `the terminal showed ${JSON.stringify(session.output.text)}`);
  same(exit, { kind: "exited", code: 2 }, "python3 on a terminal");
  return "no program with a terminal on standard input is refused with status 2";
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
  const enabled = context.enabledCommands;
  if (enabled === undefined) throw new Error("the commands were not enabled");
  await enabled.disable();
  const stub = await shell(vm, "test -e /usr/local/bin/python3 || test -e /usr/local/bin/python; echo $?");
  same(stub.stdout, "1\n", "the stubs after disable()");
  // The shell no longer finds the module: python3 is not found (127), or it is the image's own program.
  const found = await shell(vm, "python3 -c 'import sys; print(sys.executable)'");
  check(found.code === 127 || (found.code === 0 && found.stdout.trim() !== "/usr/local/bin/python3"), `python3 after disable(): ${JSON.stringify(found)}`);
  const alias = await shell(vm, "python -c 'import sys; print(sys.executable)'");
  check(alias.code === 127 || (alias.code === 0 && alias.stdout.trim() !== "/usr/local/bin/python"), `python after disable(): ${JSON.stringify(alias)}`);
  return `after disable() the stubs are gone: python3 ${found.code === 127 ? "is not found" : `is ${found.stdout.trim()}`}, python ${alias.code === 127 ? "is not found" : `is ${alias.stdout.trim()}`}`;
}

/** In the order they run: enabling comes first (scenarios.ts), turning the commands off last. */
export const COMMAND_SCENARIOS: readonly (readonly [name: string, run: (context: Context) => Promise<string>])[] = [
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
  ["command: not found after disable()", commandDisabled],
];

/** Turns the commands on for the scenarios above; `switchOf` explains a page that cannot. */
export async function enableCommands(context: Context): Promise<{ disable(): Promise<void> }> {
  return switchOf(context).enable(context.vm);
}
