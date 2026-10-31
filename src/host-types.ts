import type { Host } from "@oxidevm/sdk/wasm";

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
