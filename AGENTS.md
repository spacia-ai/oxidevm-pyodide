# oxidevm-pyodide: instructions for coding agents

This repository is an OxideVM WebAssembly module (a command) that runs Python programs with Pyodide. `module.ts` holds the
manifest (a literal) and the wiring of the adapter; the code is in `src/`. It declares the commands `python` and `python3`
(engine ADR 0027): an application turns them on for a VM, and every program there can then run them from its PATH.

- Edit `module.ts`, `src/`, `test/` and `scripts/`. Never edit `dist/`; `pnpm run build` writes it. Never edit `NOTICES.txt` or
  `SOURCE-OFFER.md` by hand; `pnpm run notices` writes them from the wheels, `upstream/lock.json` and `legal/`.
- Keep the manifest a literal. The build reads it without running code, so it cannot call functions or use variables. The
  artifact names, the option values and the upstream records are therefore written out in `module.ts` and again in
  `src/shipped.ts`; `test/manifest.test.ts` checks that the copies agree with each other and with `upstream/lock.json`.
- Declare in `requires.host` only what the adapter uses. `src/host-types.ts` (`CommandHost`) names what the command uses.
- The command line follows CPython 3.14 (`src/cli.ts`), for commands and for application starts alike; argv[0] is what the
  caller typed (`io.invocation.argv0`), or `pyodide` when the application starts the module, and every message of the
  module starts with it. The expectations come from real CPython: `test/fixtures/cpython-cli.json`, recorded by
  `python3.14 -I scripts/record-cpython-cli.py` (`--check` compares without writing). Add a case there before changing
  behaviour that CPython defines; tests normalise only the interpreter path and the version text. Behaviour that differs
  from CPython on purpose (no REPL, no `-m`, statuses limited to 119, ignored `-I` and `-P`) is tested on its own and
  listed in README.md.
- Anything that can be refused (usage, a terminal on standard input, a directory Python cannot see, an unreadable program)
  is refused before Pyodide loads, so that it costs nothing.
- Ctrl+C (`src/signals.ts`): SIGINT is trapped once Pyodide has loaded, and the runner arms Pyodide's interrupt buffer from
  inside its own `try`. Pyodide's event loop must never see a pending interrupt: every JavaScript call that Python waits for
  (`run_sync`) holds a pending Ctrl+C before it settles and resolves with its outcome instead of rejecting (`held` in
  `src/guest.ts`), and Python calls `_oxidevm_bridge.check_interrupt()` right after it, which puts the Ctrl+C back and
  raises KeyboardInterrupt. A new wait of the bridge must do the same. Ctrl+C during the program's own asyncio waits is
  not handled yet (README.md, Known limits).
- A program started as a command cannot import the JavaScript bridge (`src/python/hide-bridge.ts`); application starts can.
  It is defence in depth, not a boundary, and README.md must keep saying so.
- Import types from `@oxidevm/sdk/wasm` with `import type`; the only value import is `defineModule`. The adapter ships as one
  self-contained file. A module never imports the kit; it arrives as `host.kit`.
- No `any`, no `@ts-ignore`, no non-null assertions, no type assertions on untrusted values. Treat everything from outside
  (arguments, bytes, JSON, Python-side values, WebAssembly exports) as `unknown` and check it.
- Python lives in TypeScript string constants under `src/python/`. Anything Python-visible is tested with the real Pyodide in
  Node (`test/support/guest-fixture.ts`) and, against the real engine, in `test/browser/`.
- The mirrored upstream files in `upstream/` are not committed. `pnpm run fetch-upstream` downloads and verifies them; add a
  wheel by adding it to `upstream/lock.json`, `module.ts`, `src/shipped.ts` and `scripts/notices.ts` (RECORDED), then run
  `pnpm run notices`.
- Tests that mount the file system bridge use `test/support/workspace-fixture.ts`; tests of the Python side use
  `test/support/guest-fixture.ts`. Keep each test file near 600 lines, and when a behaviour is guarded by a branch, write the
  test that fails without it (a round of 89 one-line mutations of `src/` found 15 branches that no test guarded).
- Verify with `pnpm run check` (types, lint, and `oxidevm wasm build --check`), then `pnpm test`, then `pnpm run test:conformance` (`oxidevm wasm test` in a real browser). `pnpm run test:browser` needs
  the engine release, a signed Userspace image with python3, and Chromium (see `test/browser/harness.ts`).
- `@oxidevm/sdk` and `@oxidevm/cli` are pinned to an exact version (0.0.8, Userspace API 144, which `files.sync` and
  `files.async` need for `utimes`) and installed from npm. The committed `pnpm-workspace.yaml` only allows esbuild's install
  script and excludes those two versions from pnpm's minimum-release-age policy.
- 0.2.0 needs the release that serves module commands and `process.signals` (Userspace API 145), which is not published
  yet. Until then, develop against a local build of the SDK repository:
  `pnpm add -D @oxidevm/sdk@file:<sdk>/packages/sdk @oxidevm/cli@link:<sdk>/packages/cli` (the CLI as a link, because it
  depends on the SDK through its workspace), and never commit the resulting `package.json` and `pnpm-lock.yaml`.
- Release by tag: `pnpm run release` prints the steps.
- Commits, tags, pull requests and release notes in this repository are the maintainer's: authored as `Łukasz Potępa <lukasz@spacia.ai>`, with no AI attribution (no `Co-Authored-By` trailer, no "Generated with" line). Before pushing, `git log origin/main..HEAD --format='%an <%ae> | %cn <%ce> | %B' | grep -iE '^co-authored-by:|generated with'` must print nothing.
