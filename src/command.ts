import type { CommandHooks } from "@oxidevm/sdk/wasm";
import { guestProcess } from "./identity.ts";
import { installGuest } from "./guest.ts";
import type { CommandHost } from "./host-types.ts";
import { nativeRunner } from "./native-bridge.ts";
import { bundledEngine, loadPython } from "./python-loader.ts";
import type { Engine } from "./python-loader.ts";
import { invocationOf, pythonEnvironment, readScript, runScript, USAGE } from "./script.ts";
import { socketBridge } from "./socket-bridge.ts";
import { attachStandardStreams } from "./stdio.ts";
import { mountWorkspace } from "./workspace-fs.ts";

/**
 * The command: `main(io)` runs the Python program named by the first argument and returns its exit status. A missing
 * program is a usage error that costs nothing, because Python is started only once there is something to run.
 */
export function createCommand(host: CommandHost, engine: Engine = bundledEngine): CommandHooks {
  const sockets = socketBridge(host);
  return {
    async main(io) {
      const invocation = invocationOf(io.args, io.cwd);
      if (invocation === undefined) return host.fail(2, USAGE);
      const source = readScript(host.fs, error => host.kit.errno.of(error), invocation);
      if (source.kind === "unreadable") return host.fail(source.message.includes("can't open file") ? 2 : 1, source.message);

      const identity = guestProcess(await host.process.info(), io.cwd);
      const py = await loadPython({ packages: host.options.packages, bytes: name => host.artifacts.bytes(name), env: pythonEnvironment(io.env), log: line => { host.log(line); } }, engine);
      mountWorkspace(py.FS, host.fs, host.kit.errno, error => { host.log(JSON.stringify({ oxidevm: "log", module: "pyodide", event: "workspace-io", message: error instanceof Error ? error.message : String(error) })); });
      attachStandardStreams(py, host.fs, host.stdio, host.kit.errno);
      installGuest(py, identity, { run: nativeRunner(host), sockets });
      return runScript(py, invocation, source.text);
    },
    async close() {
      await sockets.closeAll();
    },
  };
}
