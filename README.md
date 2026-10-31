# oxidevm-pyodide

An [OxideVM](https://oxidevm.dev) WebAssembly module (a command) that runs Python programs with
[Pyodide](https://pyodide.org) (CPython 3.14.2 compiled to WebAssembly) in a Userspace JS process of the VM. The program
shares the VM's files, process ids and sockets with real Linux programs: it reads and writes `/workspace` as Linux sees it,
starts native programs, and talks to services they listen with. pandas and Matplotlib are included.

Status: pre-release `0.1.0`, built on the `wasm-modules` line of the SDK (0.1.0-alpha.301, Userspace API 144). See
[Known limits](#known-limits).

## Use it

```sh
oxidevm wasm add github:spacia-ai/oxidevm-pyodide@v0.1.0
```

The command shows what the module declares and asks before it installs anything. A module is code that runs in a worker of
your page with that authority, so review it as you would a dependency. It needs a self-hosted runtime on a cross-origin
isolated page and a browser with WebAssembly JSPI (`WebAssembly.Suspending` and `WebAssembly.promising`); without them it exits
with status 122 and names what is missing.

```ts
import { spawnModule } from "@oxidevm/sdk/wasm";
import { pyodide } from "./oxidevm.modules.generated";

await vm.workspace.writeText("_oxidevm/run.py", 'import pandas as pd\nprint(pd.__version__)\n');
const python = await spawnModule(vm, pyodide, { args: ["/workspace/_oxidevm/run.py"], cwd: "/workspace" });
const exit = await python.exit; // { kind: "exited", code: 0 }
// python.stdout, python.stderr and python.stdin are the program's standard streams.
```

Options (typed from the manifest):

| option | values | default |
| --- | --- | --- |
| `packages` | any of `contourpy`, `cycler`, `fonttools`, `kiwisolver`, `matplotlib`, `numpy`, `packaging`, `pandas`, `pillow`, `pyparsing`, `python-dateutil`, `pytz`, `six` | `["pandas", "matplotlib"]` |

The packages (and the ones they need) are unpacked before the program starts. `packages: []` starts the bare interpreter, in
about a second.

## What the program sees

- **The program** is the first argument, an absolute path (a relative one is taken from the working directory). It runs as
  `python script.py` does: `sys.argv` is the script as typed and the arguments after it, `__name__` is `"__main__"`,
  `__file__` is its absolute path, its directory is first on `sys.path`, `atexit` functions run, and top-level `await` works.
  Without a program the module prints `usage: pyodide <script.py> [argument ...]` and exits with status 2.
- **Exit status.** `0` when the program finishes. `sys.exit(n)` gives `n & 255`, limited to 119 because 120 to 125 belong to
  the module runner and the engine. An uncaught exception prints its traceback (without the runner's own frames) on standard
  error and exits with 1, as does `sys.exit("message")`, which also prints the message.
- **Standard streams** are the process's descriptors 0, 1 and 2, read and written in UTF-8.
- **Files.** `/workspace` is the VM's workspace at the same path, through the VM's own file API, so a file Python writes is at
  once the file Linux reads, and the reverse, while both run. Permissions (`open`, `os.mkdir`, `os.chmod`), `rename`,
  `unlink`, `rmdir`, `readdir`, `truncate`, symbolic links and file times (`os.utime`, to the millisecond) work, and a directory
  that holds a socket or a pipe still lists and imports. One read or write moves at most 16 MiB (larger ones continue in
  steps). Creating special files is refused. Everything outside `/workspace` is Pyodide's own in-memory file system.
- **The process.** `os.getpid()`, `getuid()`, `geteuid()`, `getgid()` and `getegid()` report the module's real Linux process;
  the working directory is the process's (inside the workspace, otherwise `/workspace`); `HOME` is `/workspace`;
  `MPLBACKEND` defaults to `Agg`, because a worker has no display. The rest of the process environment is passed on, except
  `PYTHON*` variables, which belong to the VM's own Python.

## The `oxidevm` Python module

Programs reach the Linux system around them through a module that this one installs:

```python
import oxidevm

# Run a native Linux program and wait for it. argv[0] is an absolute path.
result = oxidevm.run(["/bin/uname", "-m"], input="", check=True, timeout=10)
result.stdout, result.stderr, result.returncode, result.pid
```

`run(argv, *, input="", check=True, timeout=10)` takes at most 64 arguments, 5 MiB of input text, and a timeout of 0.001 to
180 seconds; it returns at most 1 MiB of each output stream and kills the program when it runs out of time or output. With
`check` a program that does not exit with 0 raises `RuntimeError` with the start of its standard error. `returncode` is minus
the signal number when a signal ended the program. Violations of the limits raise `pyodide.ffi.JsException` with a message
(for example `"... timed out"` or `"... exceeds the 1048576 byte output limit"`).

```python
# Talk to a service that a native program listens with: a Unix socket under /workspace/_oxidevm/ or loopback TCP.
with oxidevm.connect_unix("/workspace/_oxidevm/service.sock") as connection:
    connection.sendall(b"ping\n")
    reply = connection.recv(1024)       # b"" once the other side has closed

with oxidevm.connect_tcp(5432) as connection:             # host defaults to "127.0.0.1"
    connection.settimeout(5)            # seconds; None (the default) waits for as long as it takes
    connection.sendall(b"...")
```

`connect_unix(path, *, timeout=30.0)` and `connect_tcp(port, host="127.0.0.1", *, timeout=30.0)` return a blocking socket-like
`Connection` with `sendall`, `recv` (at most 1 MiB per call), `settimeout`, `gettimeout` and `close`, and work in `with`.
`timeout` limits only the connection attempt. Failures are the `OSError` subclass Python would raise
(`FileNotFoundError` for a missing socket file, `ConnectionRefusedError` for a socket with no server, `TimeoutError` when a
timeout runs out, `BrokenPipeError` when the other side has gone). A program may hold 32 sockets open; the module closes any it
leaves open when it ends.

## How it is built and checked

The Pyodide runtime (`pyodide.asm.wasm`, `python_stdlib.zip`, `pyodide-lock.json`) and the 13 wheels are mirrored byte for byte
from [Pyodide 314.0.7](https://github.com/pyodide/pyodide/tree/314.0.7) and pinned by sha256 in `upstream/lock.json`. They are
not committed; `pnpm run fetch-upstream` downloads and verifies them. The release pins them again in its `module.json`.

Pyodide's JavaScript is bundled into `adapter.mjs` (about 1.5 MB), with its factory imported statically, so nothing is loaded
or evaluated beyond the pinned bytes. Pyodide is told to find its files at a virtual address (`https://pyodide.invalid/`) and
a scoped `fetch` answers for that address, only, from bytes the runner has verified against the release pins; every other URL
under the virtual address is rejected and every other request goes to the real `fetch`. All files that Python will need are
verified before Pyodide starts, so a file that was altered after staging stops the module with exit status 121 before any
Python runs. Pyodide fetches that happen later (`pyodide.http`, `micropip`) go through the real `fetch`, which is why network
installs inside Python are out of scope.

## Known limits

- File times are kept to the millisecond (the VM's API takes a `Date`), and `os.utime` follows symbolic links.
- Python threads, `subprocess`, `multiprocessing` and other things Emscripten cannot do are what they are in Pyodide;
  `oxidevm.run` is how to start a native program.
- The module cancels cleanly when its process group is killed (`process.kill("SIGKILL", { scope: "process-group" })`); a
  native child started with `oxidevm.run` survives a kill of the module's process alone.
- A socket behaves like any socket: `sendall` waits when the other side is not reading and the buffers are full, so a client
  that sends a lot to a service that echoes it should read as it writes, or use `settimeout`.
- Startup depends on the host: the interpreter alone is about a second, pandas and Matplotlib add several seconds.
- Licences: see [NOTICES.txt](NOTICES.txt), [SOURCE-OFFER.md](SOURCE-OFFER.md) and the [licences](#licences) below. They have
  not had a legal review.

## Develop it

`@oxidevm/sdk` and `@oxidevm/cli` come from the private registry's `wasm-modules` dist-tag: put
`@oxidevm:registry=http://127.0.0.1:4873/` in an untracked `.npmrc` first (see `AGENTS.md`).

```sh
pnpm install
pnpm run fetch-upstream  # the mirrored runtime and wheels (about 29 MB)
pnpm run check           # tsc (module, tests, scripts), eslint with no warnings, and oxidevm wasm build --check
pnpm test                # unit tests: the real Pyodide in Node, against fakes of the VM's files, processes and sockets
pnpm run build           # dist/: module.json, adapter.mjs, the artifacts and SHA256SUMS
pnpm run test:browser    # the same module against the real engine in Chromium; see test/browser/harness.ts
pnpm run notices         # regenerate NOTICES.txt and SOURCE-OFFER.md after changing the wheels or legal/
```

The unit tests need a Node with WebAssembly JSPI (Node 26, or Node 24 with `--experimental-wasm-jspi`).

| path | what |
| --- | --- |
| `module.ts` | the manifest and the adapter's wiring, nothing else |
| `src/command.ts` | `main(io)`: what runs, in which order |
| `src/python-loader.ts`, `src/artifact-fetch.ts`, `src/lock.ts` | starting Pyodide from the release's verified files |
| `src/workspace-fs.ts` | Emscripten's file system over the VM's synchronous file API |
| `src/native-bridge.ts`, `src/socket-bridge.ts`, `src/python/` | `oxidevm.run`, `connect_unix`, `connect_tcp`, and the Python sources |
| `src/script.ts`, `src/guest.ts`, `src/stdio.ts` | running the program, process identity, standard streams |
| `upstream/lock.json`, `scripts/fetch-upstream.ts` | what is mirrored, and how |
| `legal/`, `scripts/generate-notices.ts` | pinned licence texts and the generator of `NOTICES.txt` and `SOURCE-OFFER.md` |
| `test/`, `test/browser/` | unit tests, and the real-engine harness with its scenarios |

## Release it

Publishing changes what others can install, so it goes draft, verify, publish: the draft is downloaded again and checked
against its own `SHA256SUMS` before it becomes visible. The tag must name the version in `module.ts`.

```sh
git tag v0.1.0 && git push origin v0.1.0
pnpm run build
gh release create v0.1.0 dist/* --draft --verify-tag --title v0.1.0
gh release download v0.1.0 --dir verify && (cd verify && sha256sum --check SHA256SUMS)
gh release edit v0.1.0 --draft=false
```

`pnpm run release` (`oxidevm wasm release --repo spacia-ai/oxidevm-pyodide`) prints these steps and runs none of them. The
`release` workflow does the same in GitHub Actions, in two jobs: a read-only one fetches the upstream files and builds, and a
second one, which installs nothing, drafts, verifies and publishes. Both workflows start on request only (run `release` from
the tag): the install step needs `@oxidevm/sdk` and `@oxidevm/cli`, which only a private registry serves today (see
`AGENTS.md`), so a push trigger would fail on every push.

## Licences

The code of this module (`module.ts`, `src/`, `scripts/`, `test/`) is Apache-2.0, Copyright 2026 Spacia B.V. (see `LICENSE`).
The release also carries the Pyodide runtime (MPL-2.0, with CPython under the PSF License and the libraries its build links),
and 13 wheels under BSD, MIT, MIT-CMU, Apache-2.0, PSF-based and font licences, unmodified. The manifest's `license.spdx`
names all of them, `license.source` says where the MPL-2.0 source is, and `NOTICES.txt` reproduces the licence texts.
