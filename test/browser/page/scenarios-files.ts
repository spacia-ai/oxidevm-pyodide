import { inspectPng } from "./png.ts";
import { check, expectStatus, field, native, run, same, start } from "./support.ts";
import type { Context } from "./support.ts";

// Scenarios about the files the module and the VM's Linux programs share.

const MIB = 1024 ** 2;

function parsed(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}

export async function filesBothWays(context: Context): Promise<string> {
  const { vm } = context;
  await native(vm, "/bin/sh", ["-c", "mkdir -p /workspace/shared && printf 'from Linux' > /workspace/shared/native.txt && chmod 640 /workspace/shared/native.txt"]);
  const first = await run(context, `import json, os
base = "/workspace/shared"
seen = {"native": open(base + "/native.txt").read(), "native_mode": oct(os.stat(base + "/native.txt").st_mode & 0o777)}
with open(base + "/python.txt", "w") as file:
    file.write("from Python")
with open(base + "/python.txt", "r+") as file:
    file.seek(5)
    file.write("WASM")
os.mkdir(base + "/folder")
os.rename(base + "/python.txt", base + "/folder/result.txt")
descriptor = os.open(base + "/private.txt", os.O_CREAT | os.O_WRONLY, 0o600)
os.write(descriptor, b"secret")
os.close(descriptor)
seen["listing"] = sorted(os.listdir(base))
print(json.dumps(seen, sort_keys=True))
`, { name: "files-first", packages: [] });
  expectStatus(first, 0, "first run");
  same(parsed(first.stdout), { listing: ["folder", "native.txt", "private.txt"], native: "from Linux", native_mode: "0o640" }, "what Python saw");
  const result = await native(vm, "/bin/cat", ["/workspace/shared/folder/result.txt"]);
  same(result.stdout, "from WASMon", "the file Python wrote, read by Linux");
  same((await native(vm, "/bin/stat", ["-c", "%a", "/workspace/shared/private.txt"])).stdout.trim(), "600", "the mode Python gave a new file, seen by Linux");
  same((await native(vm, "/bin/cat", ["/workspace/shared/private.txt"])).stdout, "secret", "the private file");

  await native(vm, "/bin/sh", ["-c", "printf 'changed by Linux' > /workspace/shared/native.txt"]);
  const second = await run(context, 'print(open("/workspace/shared/native.txt").read())\n', { name: "files-second", packages: [] });
  same(second.stdout, "changed by Linux\n", "a change by Linux, seen by the next run");

  // A running module and Linux share one live file system: a file written while Python waits is there when it looks.
  const live = await start(context, 'import sys\nprint("ready", flush=True)\nsys.stdin.readline()\nprint(open("/workspace/shared/live.txt").read())\n', { name: "files-live", packages: [], keepInput: true });
  await live.stdout.waitFor("ready\n");
  await native(vm, "/bin/sh", ["-c", "printf 'written while Python waits' > /workspace/shared/live.txt"]);
  await live.send("go\n");
  const answered = await live.finished;
  expectStatus(answered, 0, "live run");
  same(answered.stdout, "ready\nwritten while Python waits\n", "the live file");
  return `listing=${JSON.stringify(field(parsed(first.stdout), "listing"))} mode=600 ms=${String(first.ms)}`;
}

export async function largeFiles(context: Context): Promise<string> {
  const { vm } = context;
  const size = 20 * MIB;
  const written = await run(context, `import hashlib, json, os
data = os.urandom(${String(size)})
with open("/workspace/shared/big.bin", "wb") as file:
    file.write(data)
print(json.dumps({"size": len(data), "sha256": hashlib.sha256(data).hexdigest()}))
`, { name: "big-write", packages: [] });
  expectStatus(written, 0, "writing 20 MiB");
  const report = parsed(written.stdout);
  same((await vm.workspace.stat("shared/big.bin")).size, size, "size of the file Python wrote, seen through the workspace");
  // A Linux program is the oracle for the bytes: it reads the file from the VM's own file system.
  const started = performance.now();
  const hashed = await native(vm, "/bin/sha256sum", ["/workspace/shared/big.bin"]);
  same(hashed.stdout.split(" ")[0], field(report, "sha256"), "the bytes Python wrote, hashed by a Linux program");
  const nativeMs = Math.round(performance.now() - started);

  await native(vm, "/bin/sh", ["-c", `head -c ${String(size)} /dev/urandom > /workspace/shared/from-linux.bin`]);
  const linuxHash = (await native(vm, "/bin/sha256sum", ["/workspace/shared/from-linux.bin"])).stdout.split(" ")[0];
  const read = await run(context, `import hashlib, json
with open("/workspace/shared/from-linux.bin", "rb") as file:
    data = file.read()
print(json.dumps({"size": len(data), "sha256": hashlib.sha256(data).hexdigest()}))
`, { name: "big-read", packages: [] });
  expectStatus(read, 0, "reading 20 MiB");
  same(parsed(read.stdout), { size, sha256: linuxHash }, "the bytes Linux wrote, read by Python");
  return `${String(size / MIB)} MiB both ways; write run ${String(written.ms)} ms, read run ${String(read.ms)} ms, Linux sha256sum ${String(nativeMs)} ms`;
}

export async function metadata(context: Context): Promise<string> {
  const { vm } = context;
  const result = await run(context, `import errno, json, os, shutil
base = "/workspace/meta"
os.makedirs(base, exist_ok=True)
with open(base + "/data.bin", "wb") as file:
    file.write(bytes(range(256)) * 4)
os.chmod(base + "/data.bin", 0o640)
os.truncate(base + "/data.bin", 100)
with open(base + "/data.bin", "r+b") as file:
    file.truncate(50)
os.symlink("data.bin", base + "/link.bin")
shutil.copy(base + "/data.bin", base + "/copy.bin")
try:
    os.utime(base + "/data.bin", (1, 1))
    utime = "ok"
except OSError as error:
    utime = type(error).__name__ + ":" + errno.errorcode[error.errno]
print(json.dumps({
    "readlink": os.readlink(base + "/link.bin"),
    "islink": [os.path.islink(base + "/link.bin"), os.path.islink(base + "/data.bin")],
    "size_through_link": os.stat(base + "/link.bin").st_size,
    "mode": oct(os.stat(base + "/data.bin").st_mode & 0o777),
    "copy_mode": oct(os.stat(base + "/copy.bin").st_mode & 0o777),
    "copy_size": os.path.getsize(base + "/copy.bin"),
    "utime": utime,
}, sort_keys=True))
`, { name: "metadata", packages: [] });
  expectStatus(result, 0, "metadata run");
  const seen = parsed(result.stdout);
  same(seen, { copy_mode: "0o640", copy_size: 50, islink: [true, false], mode: "0o640", readlink: "data.bin", size_through_link: 50, utime: "OSError:ENOTSUP" }, "what Python saw");
  same((await native(vm, "/bin/stat", ["-c", "%a %s", "/workspace/meta/data.bin"])).stdout.trim(), "640 50", "mode and size, seen by Linux");
  same((await native(vm, "/bin/readlink", ["/workspace/meta/link.bin"])).stdout.trim(), "data.bin", "the link Python made, read by Linux");
  same((await native(vm, "/bin/stat", ["-c", "%a %s", "/workspace/meta/copy.bin"])).stdout.trim(), "640 50", "the copy, seen by Linux");
  return "chmod, truncate, symlink, readlink and shutil.copy reach the VM; os.utime is not supported (ENOTSUP)";
}

export async function plot(context: Context): Promise<string> {
  const { vm } = context;
  const result = await run(context, `import os
os.environ["MPLCONFIGDIR"] = "/workspace/_oxidevm/matplotlib"
os.makedirs("/workspace/plots", exist_ok=True)
import pandas as pd
frame = pd.DataFrame({"country": ["Netherlands", "Germany", "France"], "revenue": [299, 119, 99]})
axes = frame.plot.bar(x="country", y="revenue", legend=False, title="Revenue by country", figsize=(4, 3))
axes.figure.tight_layout()
axes.figure.savefig("/workspace/plots/plot.png", dpi=100)
print(os.path.getsize("/workspace/plots/plot.png"), os.environ["MPLBACKEND"])
`, { name: "plot" });
  expectStatus(result, 0, "plot run");
  const file = await vm.workspace.read("plots/plot.png", { maxBytes: 4 * MIB });
  const info = inspectPng(file.data);
  same({ width: info.width, height: info.height }, { width: 400, height: 300 }, "size of the plot");
  check(info.chunks.includes("IDAT") && info.chunks.at(-1) === "IEND", "the plot has no image data");
  same(result.stdout, `${String(file.data.length)} Agg\n`, "what Python printed (the file size, and Agg as the module's default backend)");
  const described = await native(vm, "/bin/file", ["/workspace/plots/plot.png"]);
  check(described.stdout.includes("PNG image data, 400 x 300"), `Linux does not recognise the plot as a 400 x 300 PNG: ${described.stdout}`);
  return `${String(file.data.length)} bytes, ${String(info.width)}x${String(info.height)}, chunks ${info.chunks.join(" ")}; Linux says: ${described.stdout.trim()}`;
}
