import { createVM, defineImage } from "@oxidevm/sdk";
import type { UserspaceVM } from "@oxidevm/sdk";
import type { ModuleHandle } from "@oxidevm/sdk/wasm";
import { COMMAND_SCENARIOS, enableCommands } from "./scenarios-commands.ts";
import type { CommandSwitch } from "./scenarios-commands.ts";
import { filesBothWays, largeFiles, metadata, plot } from "./scenarios-files.ts";
import { cancellation, exitStatuses, identity, nativeRun, packagesOption, pandas, standardStreams, startupTiming, tamperedArtifact } from "./scenarios-process.ts";
import { sockets } from "./scenarios-sockets.ts";
import type { Context } from "./support.ts";

export interface ScenarioConfig {
  readonly origin: string;
  readonly image: { readonly manifestUrl: string; readonly manifestSHA256: string; readonly trust: { readonly algorithm: "Ed25519"; readonly keyId: string; readonly publicKey: string } };
  /** Run only the scenarios whose name contains this text. */
  readonly only?: string;
}

export interface ScenarioResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

type Scenario = readonly [name: string, run: (context: Context) => Promise<string>];

/** In the order they run. The first one pays for the cold start of the browser's caches. */
const SCENARIOS: readonly Scenario[] = [
  ["numpy and pandas compute in the module", pandas],
  ["the packages option selects what is loaded, and the SDK refuses an unknown package", packagesOption],
  ["stdin, stdout and stderr are the process's descriptors 0, 1 and 2, and the exit status comes back", standardStreams],
  ["os.getpid, getuid and getgid report the module's real Linux process", identity],
  ["exit statuses: success, traceback, SystemExit n (limited to 119), usage and unreadable program", exitStatuses],
  ["a file altered after staging is refused before any module code runs (exit 121)", tamperedArtifact],
  ["files are shared both ways with native Linux, permissions included, while the module runs", filesBothWays],
  ["files of 20 MiB cross the module's transfer limit in both directions", largeFiles],
  ["chmod, truncate, symlink, shutil.copy and utime reach the VM's files", metadata],
  ["oxidevm.run runs native programs with input, status, timeout and output bounds", nativeRun],
  ["cancelling the module retires its native child in under 5 seconds", cancellation],
  ["matplotlib writes a valid PNG that Linux recognises", plot],
  ["oxidevm.connect_unix and connect_tcp talk to native services", sockets],
  ["startup timing, for the record", startupTiming],
];

const SCENARIO_TIMEOUT_MS = 300_000;

async function withDeadline<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error(`${label} did not finish within ${String(SCENARIO_TIMEOUT_MS)} ms`)); }, SCENARIO_TIMEOUT_MS); });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function openVM(config: ScenarioConfig): Promise<UserspaceVM> {
  const image = defineImage({ mode: "userspace", ...config.image });
  return createVM({ mode: "userspace", image, memoryMiB: 1536, runtime: { hosting: "self-hosted", baseUrl: `${config.origin}/engine/` }, network: { mode: "local" }, restorePoint: "none" });
}

/**
 * Boots one Userspace VM from the pinned engine and the signed image, then runs every scenario against the installed
 * module, reporting each result through `report` as it finishes. The command scenarios run last, with the module's
 * commands turned on through `commands`.
 */
export async function runScenarios(config: ScenarioConfig, pyodide: ModuleHandle, report: (result: ScenarioResult) => void, commands?: CommandSwitch): Promise<readonly ScenarioResult[]> {
  const booting = performance.now();
  const vm = await openVM(config);
  const results: ScenarioResult[] = [];
  const record = (result: ScenarioResult): void => { results.push(result); report(result); };
  try {
    record({ name: "boot", ok: true, detail: `Userspace VM ready in ${String(Math.round(performance.now() - booting))} ms` });
    await vm.workspace.createDirectory("_oxidevm").catch(() => undefined);
    const context: Context = { vm, pyodide, ...(commands === undefined ? {} : { commands }) };
    const attempt = async (name: string, run: (given: Context) => Promise<string>, given: Context): Promise<void> => {
      if (config.only !== undefined && !name.includes(config.only)) return;
      try {
        record({ name, ok: true, detail: await withDeadline(run(given), name) });
      } catch (error: unknown) {
        record({ name, ok: false, detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
      }
    };
    for (const [name, run] of SCENARIOS) await attempt(name, run, context);
    let enabled: { disable(): Promise<void> } | undefined;
    await attempt("command: enableModuleCommands turns python and python3 on", async given => { enabled = await enableCommands(given); return "enabled"; }, context);
    for (const [name, run] of COMMAND_SCENARIOS) await attempt(name, run, enabled === undefined ? context : { ...context, enabledCommands: enabled });
  } finally {
    await vm.dispose();
  }
  return results;
}
