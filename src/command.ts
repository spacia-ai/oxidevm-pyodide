import type { CommandHooks, CommandIO } from "@oxidevm/sdk/wasm";
import { helpText, parseCommandLine, usageError, versionText } from "./cli.ts";
import type { CommandLine } from "./cli.ts";
import { guestProcess } from "./identity.ts";
import { hideJavaScript, installGuest } from "./guest.ts";
import type { CommandHost } from "./host-types.ts";
import { nativeRunner } from "./native-bridge.ts";
import { netBridge } from "./net-bridge.ts";
import { bundledEngine, loadPython } from "./python-loader.ts";
import type { Engine } from "./python-loader.ts";
import { HOST_ARGV0, placementRefusal, prepareProgram, pythonEnvironment, runProgram } from "./script.ts";
import { catchInterrupts, createInterrupts, endBySignal } from "./signals.ts";
import type { Launch } from "./script.ts";
import type { PythonCommand } from "./shipped.ts";
import { socketBridge } from "./socket-bridge.ts";
import { attachStandardStreams } from "./stdio.ts";
import { mountTree, visibleTrees } from "./workspace-fs.ts";

type IO = CommandIO<PythonCommand>;

/** How the process was started: by a program in the VM through one of the commands, or by the application. */
function launchOf(io: IO): Launch {
  const { invocation } = io;
  return invocation.kind === "command"
    ? { argv0: invocation.argv0, args: io.args, cwd: io.cwd, executable: invocation.path }
    : { argv0: HOST_ARGV0, args: io.args, cwd: io.cwd, executable: "" };
}

/**
 * Answers -V, -h and a command line that cannot be used, without starting Python. Like CPython, which prints the
 * version and the help with `printf`, a reader that has gone away does not make them fail.
 */
function answer(host: CommandHost, io: IO, argv0: string, line: Exclude<CommandLine, { kind: "run" }>): number {
  const print = (text: string): number => {
    try {
      host.fs.writeAll(io.stdout, new TextEncoder().encode(text));
    } catch {
      // Nothing to do: the output had nowhere to go.
    }
    return 0;
  };
  switch (line.kind) {
    case "version": return print(versionText());
    case "help": return print(helpText(argv0));
    case "usage-error": return host.fail(2, usageError(argv0, line.message).trimEnd());
  }
}

/**
 * The command: `main(io)` reads the command line as CPython 3.14 does and runs the program it names (a file, the text
 * after -c, a module after -m, or standard input) with the trees of the VM that Python sees mounted, and CPython's basic
 * interactive interpreter when standard input is a terminal with no program, or after the program with -i. Everything that can be refused is refused
 * before Python starts, so a usage error, a missing file or a directory Python cannot see costs nothing. Ctrl+C is
 * KeyboardInterrupt once the program runs; left unhandled, it ends the process killed by SIGINT, as with CPython.
 */
export function createCommand(host: CommandHost, engine: Engine = bundledEngine): CommandHooks<PythonCommand> {
  const sockets = socketBridge(host);
  const net = netBridge(host, error => host.kit.net.errno(error));
  const report = (error: unknown): void => { host.log(JSON.stringify({ oxidevm: "log", module: "pyodide", event: "workspace-io", message: error instanceof Error ? error.message : String(error) })); };
  return {
    async main(io) {
      const launch = launchOf(io);
      const line = parseCommandLine(io.args);
      if (line.kind !== "run") return answer(host, io, launch.argv0, line);
      const trees = visibleTrees(io.env["HOME"], host.fs);
      const refusal = placementRefusal(launch.argv0, launch.cwd, line, trees);
      if (refusal !== undefined) return host.fail(2, refusal);
      for (const warning of line.warnings) host.log(warning);
      const prepared = prepareProgram({ fs: host.fs, errnoOf: error => host.kit.errno.of(error), stdin: io.stdin, stdinIsTerminal: io.terminals.stdin }, launch, line);
      if (prepared.kind === "failed") return host.fail(prepared.status, prepared.message);

      const info = await host.process.info();
      const python = await loadPython({
        packages: host.options.packages, bytes: name => host.artifacts.bytes(name), compile: name => host.artifacts.compile(name),
        env: pythonEnvironment(io.env), log: text => { host.log(text); }, networkImports: imports => { host.kit.emscripten.networkImports(imports); },
      }, engine);
      const { py } = python;
      // Python's sockets and Emscripten's own name lookups go to the VM's network (engine ADR 0029, N-4).
      // Python's socket timeouts become the receive timeouts of those sockets (src/python/socket-patch.ts).
      net.attachSockets(host.kit.emscripten.network(host, Reflect.get(py, "_module")));
      for (const tree of trees) mountTree(py.FS, host.fs, host.kit.errno, tree, report);
      attachStandardStreams(py, host.fs, host.stdio, host.kit.errno, io.terminals, info.terminal);
      const interrupts = createInterrupts();
      installGuest(py, guestProcess(info, launch.cwd), { run: nativeRunner(host), sockets, interrupts, packages: python, net });
      // Defence in depth, not a boundary: a program in the VM must not reach the page's JavaScript through Python.
      if (io.invocation.kind === "command") hideJavaScript(py);
      const trap = await catchInterrupts(host.process.signals, interrupts);
      const outcome = await runProgram(py, prepared.request, () => { interrupts.arm(py); });
      return outcome.kind === "exit" ? outcome.status : endBySignal(host.process.signals, trap);
    },
    async close() {
      net.freeAll();
      await sockets.closeAll();
    },
  };
}
