# oxidevm-pyodide

An [OxideVM](https://oxidevm.dev) WebAssembly module (a command) that runs Python programs with
[Pyodide](https://pyodide.org) (CPython 3.14.2 compiled to WebAssembly) in a Userspace JS process of the VM. The program
shares the VM's files, process ids and sockets with real Linux programs: it reads and writes the VM's files as Linux sees
them, starts native programs, and talks to services they listen with. pandas and Matplotlib are included. An application can
start it, or turn on its commands, `python3` and `python`, so that shells, scripts and other programs of the VM run it from
their PATH like any program.

Status: pre-release `0.2.0`, built on the SDK 0.0.9 (Userspace API 145), which serves module commands and the
`process.signals` capability (engine ADR 0027). See [Known limits](#known-limits) and [Changes in 0.2.0](#changes-in-020).

## Use it

```sh
oxidevm wasm add github:spacia-ai/oxidevm-pyodide@v0.2.0
```

The command shows what the module declares and asks before it installs anything. A module is code that runs in a worker of
your page with that authority, so review it as you would a dependency. It needs a self-hosted runtime on a cross-origin
isolated page and a browser with WebAssembly JSPI (`WebAssembly.Suspending` and `WebAssembly.promising`); without them it exits
with status 122 and names what is missing.

### As commands of the VM

```ts
import { enableModuleCommands } from "@oxidevm/sdk/wasm";
import { pyodide } from "./oxidevm.modules.generated";

const python = await enableModuleCommands(vm, pyodide, { commands: ["python3"], options: { packages: ["numpy"] } });
// Any program in the VM now runs /usr/local/bin/python3: a shell, a script that starts with #!/usr/bin/env python3,
// make, another module. A program it does not find there is the image's own, if the image has one.
const result = await vm.exec({ command: "/bin/sh", args: ["-c", "python3 -c 'import numpy; print(numpy.__version__)'"] });
await python.disable(); // the commands are gone: the shell finds the image's python3, or none
```

Leave out `commands` to turn on both names. `python3` and `python` come before the image's own programs on the default PATH,
so they replace an image's `/usr/bin/python3` for programs that look it up by name. The application chooses the options
when it turns the commands on; a program in the VM chooses only the command line, environment, directory and standard
streams. **Read [Known limits](#known-limits) before turning them on:** a program that runs `python3` runs code in a worker
of your page's origin, and every run starts Pyodide again, so keep `packages` short.

### Started by the application

```ts
import { spawnModule } from "@oxidevm/sdk/wasm";
import { pyodide } from "./oxidevm.modules.generated";

await vm.workspace.writeText("_oxidevm/run.py", 'import pandas as pd\nprint(pd.__version__)\n');
const python = await spawnModule(vm, pyodide, { args: ["/workspace/_oxidevm/run.py"], cwd: "/workspace" });
const exit = await python.exit; // { kind: "exited", code: 0 }
// python.stdout, python.stderr and python.stdin are the program's standard streams.
```

`args` is the command line after `python3`, read the same way (see below); messages name the module `pyodide`.

Options (typed from the manifest):

| option | values | default |
| --- | --- | --- |
| `packages` | any of `contourpy`, `cycler`, `fonttools`, `kiwisolver`, `matplotlib`, `numpy`, `packaging`, `pandas`, `pillow`, `pyparsing`, `python-dateutil`, `pytz`, `six` | `["pandas", "matplotlib"]` |

The packages (and the ones they need) are unpacked before the program starts. `packages: []` starts the bare interpreter, in
about a second.

## What the program sees

- **The command line** is read as CPython 3.14 reads its own: `python3 FILE [arg ...]`, `python3 -c CODE [arg ...]`,
  `python3 - [arg ...]` and `python3` alone, which read the program from standard input (to its end, at most 16 MiB) when
  standard input is not a terminal. Flags group (`-uc CODE`), and option parsing stops at the file, at `-` and at `--`.
  `-V` and `--version` print `Python 3.14.2`, `-h` and `--help` print the options. `-u`, `-B`, `-E`, `-s`, `-I`, `-P` and
  `-q` are accepted and change nothing: `PYTHON*` variables are never passed on, so `-E` and `-I` have nothing to ignore.
  `-m` and every other option are refused with CPython's own message, the usage line and status 2. When the application
  starts the module, the same rules apply and the module calls itself `pyodide`.
- **How it was started**, as CPython reports it: `sys.argv` is the file as typed, `-c` or `-`, then the arguments (`['']`
  for a program read from standard input without `-`); `sys.orig_argv` is the whole command line; `sys.executable` is the
  command's path (`/usr/local/bin/python3`, or empty when the application starts the module); the program's name in
  tracebacks is its absolute path, `<string>` or `<stdin>`; `__file__` is the absolute path (`<stdin>` for standard input,
  none for `-c`); `sys.path[0]` is the file's real directory (`''`, the working directory, for `-c` and standard input);
  `__name__` is `"__main__"`. `atexit` functions run, and top-level `await` works.
- **Exit status.** `0` when the program finishes, `1` for an uncaught exception (its traceback, without the runner's own
  frames, goes to standard error) and for `sys.exit("message")`, which prints the message. `sys.exit(n)` gives `n & 255`,
  limited to 119, because 120 to 125 belong to the module runner and the engine. `2` for a command line, a file or a
  directory the module cannot use. A KeyboardInterrupt that the program does not handle prints its traceback, runs `atexit`
  and ends the process killed by SIGINT, as CPython does: a shell sees 130 and stops a loop.
- **Ctrl+C** reaches the program as KeyboardInterrupt while it computes, reads standard input or files, sleeps in
  `time.sleep` (which this module replaces with one that Ctrl+C ends at once), and waits in `oxidevm.run` or a socket of the
  `oxidevm` module. A Ctrl+C while Pyodide starts, before the program runs, ends the process at once.
- **Standard streams** are the process's descriptors 0, 1 and 2, read and written in UTF-8. `isatty()` and
  `os.get_terminal_size()` answer for them as for a native process, with the size the terminal had when the process
  started.
- **Files.** Python sees the VM's `/workspace`, `/tmp` and home directory (`$HOME`, when it is a directory that is neither
  at, inside nor around Pyodide's own `/`, `/lib`, `/dev`, `/proc` and `/home/pyodide`), each at its own path, through the
  VM's own file API, so a file Python writes is at once the file Linux reads, and the reverse, while both run. Permissions
  (`open`, `os.mkdir`, `os.chmod`), `rename`, `unlink`, `rmdir`, `readdir`, `truncate`, symbolic links and file times
  (`os.utime`, to the millisecond) work, and a directory that holds a socket or a pipe still lists and imports. One read or
  write moves at most 16 MiB (larger ones continue in steps). Creating special files is refused, and `os.rename` from one of
  these trees to another fails with `EXDEV`, as between two file systems (`shutil.move` copies). Everything else is Pyodide's
  own in-memory file system. The working directory and a program file must be in one of these trees: anywhere else the
  command stops with status 2 before Python loads (`python3: cannot run in '/etc': this Python sees the VM's files only
  under /workspace, /tmp and $HOME`).
- **The process.** `os.getpid()`, `getuid()`, `geteuid()`, `getgid()` and `getegid()` report the module's real Linux process;
  the working directory is the process's; `HOME` is the process's; `MPLBACKEND` defaults to `Agg`, because a worker has no
  display. The rest of the process environment is passed on, except `PYTHON*` variables, which belong to the VM's own Python.
- **JavaScript.** A program started as a command cannot import Pyodide's bridge to JavaScript: `js`, `pyodide_js`,
  `pyodide.ffi`, `pyodide.http` and `pyodide.code` raise `ModuleNotFoundError` (or `ImportError` for `from pyodide import
  ffi`). A program the application starts keeps them.

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
(for example `"... timed out"` or `"... exceeds the 1048576 byte output limit"`); a program started as a command cannot import
`pyodide.ffi`, so it catches them as `Exception`. Ctrl+C while `run` waits kills the native program and raises
KeyboardInterrupt.

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
timeout runs out, `BrokenPipeError` when the other side has gone), and Ctrl+C during a call raises KeyboardInterrupt. A program
may hold 32 sockets open; the module closes any it leaves open when it ends.

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

- **Commands open your page to the programs of the VM.** A program that runs `python3` or `python` hands Python code to a
  worker of your page's origin: it could make same-origin requests with your page's cookies and reach its IndexedDB, OPFS
  data and BroadcastChannels. Hiding the JavaScript bridge from commands is defence in depth, not a boundary: Pyodide's
  private modules, and objects that the `oxidevm` module holds, still lead to JavaScript. Turn the commands on only in a VM
  whose programs you would let run in your page.
- Every run starts Pyodide again and unpacks the packages the application chose; how long that takes depends on the host:
  about a second for the interpreter alone, several more with pandas and Matplotlib. Turn the commands on with the smallest
  `packages` list that the programs need.
- There is no interactive interpreter yet: `-i`, and no program or `-` with a terminal on standard input, stop with
  `python3: the interactive interpreter is not supported yet; use FILE, -c CODE or -` and status 2. `-m` is refused too.
- `sys.exit(n)` with `n & 255` above 119 exits with 119 (CPython exits with up to 255). `-I` and `-P` do not take the
  program's directory off `sys.path`, as CPython does with them.
- Only Ctrl+C (SIGINT) reaches the program. SIGTERM, SIGHUP, SIGQUIT, SIGUSR1 and SIGUSR2 keep their default action, which
  ends the process, so Python handlers installed for them with `signal.signal` are never called.
- Ctrl+C while a program awaits asyncio work of its own (a top-level `await`, `asyncio.run`, a task's timer) is taken by
  Pyodide's event loop instead of the program, and the program stops responding; end it with Ctrl+\\ (SIGQUIT) or a kill.
  `time.sleep`, the calls of the `oxidevm` module, reads and computation are interrupted as described above.
- File times are kept to the millisecond (the VM's API takes a `Date`), and `os.utime` follows symbolic links.
- Python threads, `subprocess`, `multiprocessing` and other things Emscripten cannot do are what they are in Pyodide;
  `oxidevm.run` is how to start a native program.
- The module cancels cleanly when its process group is killed (`process.kill("SIGKILL", { scope: "process-group" })`); a
  native child started with `oxidevm.run` survives a kill of the module's process alone.
- A socket behaves like any socket: `sendall` waits when the other side is not reading and the buffers are full, so a client
  that sends a lot to a service that echoes it should read as it writes, or use `settimeout`.
- Licences: see [NOTICES.txt](NOTICES.txt), [SOURCE-OFFER.md](SOURCE-OFFER.md) and the [licences](#licences) below. The
  maintainer has signed them off; they have not had an independent legal review.

## Develop it

`@oxidevm/sdk` and `@oxidevm/cli` are exact devDependencies, installed from npm (see `AGENTS.md`, which also says how to
work against an SDK that is not published yet).

```sh
pnpm install
pnpm run fetch-upstream  # the mirrored runtime and wheels (about 29 MB)
pnpm run check           # tsc (module, tests, scripts), eslint with no warnings, and oxidevm wasm build --check
pnpm test                # unit tests: the real Pyodide in Node, against fakes of the VM's files, processes and sockets
pnpm run build           # dist/: module.json, adapter.mjs, the artifacts and SHA256SUMS
pnpm run test:conformance  # oxidevm wasm test: the runner's contract, in Chromium
pnpm run test:browser    # the same module against the real engine in Chromium; see test/browser/harness.ts
pnpm run notices         # regenerate NOTICES.txt and SOURCE-OFFER.md after changing the wheels or legal/
python3.14 -I scripts/record-cpython-cli.py   # record CPython 3.14's command-line behaviour again (--check compares)
```

The unit tests need a Node with WebAssembly JSPI (Node 26, or Node 24 with `--experimental-wasm-jspi`).

| path | what |
| --- | --- |
| `module.ts` | the manifest and the adapter's wiring, nothing else |
| `src/command.ts` | `main(io)`: what runs, in which order |
| `src/cli.ts`, `scripts/record-cpython-cli.py`, `test/fixtures/cpython-cli.json` | the command line, and CPython's own behaviour that it is tested against |
| `src/signals.ts`, `src/python/sleep-patch.ts` | Ctrl+C: SIGINT's trap, waits that hold an interrupt, `time.sleep` |
| `src/python/hide-bridge.ts` | the JavaScript bridge that commands cannot import |
| `src/python-loader.ts`, `src/artifact-fetch.ts`, `src/lock.ts` | starting Pyodide from the release's verified files |
| `src/workspace-fs.ts` | Emscripten's file system over the VM's synchronous file API, and which trees Python sees |
| `src/native-bridge.ts`, `src/socket-bridge.ts`, `src/python/` | `oxidevm.run`, `connect_unix`, `connect_tcp`, and the Python sources |
| `src/script.ts`, `src/guest.ts`, `src/stdio.ts` | running the program, process identity, standard streams |
| `upstream/lock.json`, `scripts/fetch-upstream.ts` | what is mirrored, and how |
| `legal/`, `scripts/generate-notices.ts` | pinned licence texts and the generator of `NOTICES.txt` and `SOURCE-OFFER.md` |
| `test/`, `test/browser/` | unit tests, and the real-engine harness with its scenarios |

## Release it

Publishing changes what others can install, so it goes draft, verify, publish: the draft is downloaded again and checked
against its own `SHA256SUMS` before it becomes visible. The tag must name the version in `module.ts`.

```sh
git tag v0.2.0 && git push origin v0.2.0
pnpm run build
gh release create v0.2.0 dist/* --draft --verify-tag --title v0.2.0
gh release download v0.2.0 --dir verify && (cd verify && sha256sum --check SHA256SUMS)
gh release edit v0.2.0 --draft=false
```

`pnpm run release` (`oxidevm wasm release --repo spacia-ai/oxidevm-pyodide`) prints these steps and runs none of them. The
`release` workflow does the same in GitHub Actions, in two jobs: a read-only one fetches the upstream files and builds, and a
second one, which installs nothing, drafts, verifies and publishes. The `ci` workflow runs on pushes to `main` and on pull
requests, and `release` runs when a `v*` tag is pushed.

## Changes in 0.2.0

- **Commands.** The module declares `python` and `python3` and the `process.signals` capability, so installing 0.2.0 asks
  for consent again. An application turns the commands on with `enableModuleCommands` (SDK 0.0.9, Userspace API 145).
- **The command line is CPython's, for application starts too.** `spawnModule` arguments are read as `python3` reads its
  own, with `pyodide` as the command's name. A start without a program now reads one from standard input (0.1.0 printed
  `usage: pyodide <script.py> [argument ...]` and exited with 2), `-c` and `-` work, `-V` and `-h` answer, and other options
  are refused with CPython's message. Messages that 0.1.0 printed (`pyodide: can't open file ...`) read as before.
- **Files.** `/tmp` and the home directory are visible besides `/workspace`. A working directory or program file outside
  them stops the module with status 2; 0.1.0 started Python in `/workspace` instead.
- **Environment.** `HOME` is the process's own (0.1.0 set it to `/workspace`).
- **What the program sees** follows CPython more closely: `sys.executable`, `sys.orig_argv`, and `sys.path[0]` in place of
  Pyodide's own empty entry (0.1.0 kept both, so the working directory was importable too).
- **Ctrl+C** raises KeyboardInterrupt; left unhandled, it ends the process killed by SIGINT. `time.sleep` ends at once.
- **Terminals.** `isatty()` and `os.get_terminal_size()` tell the truth about the standard streams.
- **JavaScript.** A program started as a command cannot import `js`, `pyodide_js`, `pyodide.ffi`, `pyodide.http` or
  `pyodide.code`.

## Licences

The code of this module (`module.ts`, `src/`, `scripts/`, `test/`) is Apache-2.0, Copyright 2026 Spacia B.V. (see `LICENSE`).
The release also carries the Pyodide runtime (MPL-2.0, with CPython under the PSF License and the libraries its build links),
and 13 wheels under BSD, MIT, MIT-CMU, Apache-2.0, PSF-based and font licences, unmodified. The manifest's `license.spdx`
names all of them, `license.source` says where the MPL-2.0 source is, and `NOTICES.txt` reproduces the licence texts.
