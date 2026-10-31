import type { Host } from "@oxidevm/sdk/wasm";
import type { PackageName, ShippedFile } from "./shipped.ts";

// The host members this module uses, named once. They come from the capabilities the manifest declares, so a change
// to `requires.host` in module.ts that drops one of them is a type error here.

/** Synchronous file operations on the VM's files (`files.sync`). */
export type SyncFiles = Host<"files.sync">["fs"];
/** The same operations as promises (`files.async`). */
export type AsyncFiles = Host<"files.async">["files"];
/** Client sockets (`sockets.connect`). */
export type ClientSockets = Host<"sockets.connect">["sockets"];
/** A file descriptor of this process. */
export type FileDescriptor = ReturnType<SyncFiles["open"]>;
/** The errno helpers of `host.kit`. */
export type KitErrno = Host["kit"]["errno"];

/** What the command uses of the host, spelled out so that a test can supply exactly that much. The runner's host has all of it. */
export interface CommandHost {
  /** The module's lifetime: it ends when the module stops. */
  readonly signal: AbortSignal;
  /** The packages the program asked for through the module's `packages` option (defaults applied). */
  readonly options: { readonly packages: readonly PackageName[] };
  readonly artifacts: { bytes(name: ShippedFile): Promise<Uint8Array<ArrayBuffer>> };
  readonly kit: Pick<Host["kit"], "errno" | "runNative">;
  readonly stdio: Host["stdio"];
  readonly fs: SyncFiles;
  readonly files: Pick<AsyncFiles, "read" | "writeAll" | "close">;
  readonly sockets: ClientSockets;
  readonly process: Pick<Host<"process.info" | "process.spawn">["process"], "info" | "spawn" | "wait" | "signal">;
  log(line: string): void;
  fail(status: number, message: string): number;
}
