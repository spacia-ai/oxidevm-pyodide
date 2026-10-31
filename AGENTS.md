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
- Verify with `pnpm run check` (types, lint, and `oxidevm wasm build --check`), then `pnpm test`. `pnpm run test:browser` needs
  the engine release, a signed Userspace image with python3, and Chromium (see `test/browser/harness.ts`).
- The SDK packages are installed from local tarballs until they are published: keep `package.json` at the version it names,
  and put the tarball paths in an untracked `pnpm-workspace.yaml` (`overrides:` for `@oxidevm/sdk` and `@oxidevm/cli`, and
  `allowBuilds: { esbuild: true }`). Do not commit `pnpm-workspace.yaml` or `pnpm-lock.yaml` before the alpha exists.
- Release by tag: `pnpm run release` prints the steps.
