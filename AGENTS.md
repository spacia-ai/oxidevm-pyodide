# oxidevm-pyodide: instructions for coding agents

This repository is an OxideVM WebAssembly module (a command) that runs Python programs with Pyodide. `module.ts` holds the
manifest (a literal) and the wiring of the adapter; the code is in `src/`.

- Edit `module.ts`, `src/`, `test/` and `scripts/`. Never edit `dist/`; `pnpm run build` writes it. Never edit `NOTICES.txt` or
  `SOURCE-OFFER.md` by hand; `pnpm run notices` writes them from the wheels, `upstream/lock.json` and `legal/`.
- Keep the manifest a literal. The build reads it without running code, so it cannot call functions or use variables. The
  artifact names, the option values and the upstream records are therefore written out in `module.ts` and again in
  `src/shipped.ts`; `test/manifest.test.ts` checks that the copies agree with each other and with `upstream/lock.json`.
- Declare in `requires.host` only what the adapter uses. `src/host-types.ts` (`CommandHost`) names what the command uses.
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
- Verify with `pnpm run check` (types, lint, and `oxidevm wasm build --check`), then `pnpm test`. `pnpm run test:browser` needs
  the engine release, a signed Userspace image with python3, and Chromium (see `test/browser/harness.ts`).
- `@oxidevm/sdk` and `@oxidevm/cli` are pinned to an exact version (0.0.7, Userspace API 144, which `files.sync` and
  `files.async` need for `utimes`) and installed from npm. The committed `pnpm-workspace.yaml` only allows esbuild's install
  script and excludes those two versions from pnpm's minimum-release-age policy.
- Release by tag: `pnpm run release` prints the steps.
- Commits, tags, pull requests and release notes in this repository are the maintainer's: authored as `Łukasz Potępa <lukasz@spacia.ai>`, with no AI attribution (no `Co-Authored-By` trailer, no "Generated with" line). Before pushing, `git log origin/main..HEAD --format='%an <%ae> | %cn <%ce> | %B' | grep -iE '^co-authored-by:|generated with'` must print nothing.
