import type { CommandHost } from "./host-types.ts";
import type { ProcessIdentity } from "./guest.ts";
import { workingDirectory } from "./script.ts";

/** The identity Python reports: what the VM says about this process, and the directory the command was started in. */
export function guestProcess(info: Awaited<ReturnType<CommandHost["process"]["info"]>>, cwd: string): ProcessIdentity {
  return { pid: info.pid, uid: info.uid, gid: info.gid, cwd: workingDirectory(cwd) };
}
