# Source offer

This release contains the Pyodide runtime, which is licensed under the Mozilla Public License 2.0, and Python wheels under
other open-source licences (see `NOTICES.txt`). None of them is modified: the files in the release are the files the
projects published, and the table below gives the sha256 of each so that you can check that.

## Where the source of the MPL-2.0 parts is

The Source Code Form of Pyodide 314.0.7 (the interpreter build `pyodide.asm.wasm`, `python_stdlib.zip`, `pyodide-lock.json`, and the
JavaScript of `pyodide.mjs` and `pyodide.asm.mjs`, which is bundled into `adapter.mjs`) is available from the Pyodide project:

- repository: https://github.com/pyodide/pyodide
- tag: `314.0.7`
- commit: `b1e4fcc2488962f6360a97f19b9982d6fdb5d16f`
- the published npm package: `pyodide@314.0.7` (https://registry.npmjs.org/pyodide/-/pyodide-314.0.7.tgz), integrity `sha512-0YvXxEhfEdpLfb/XkM2BFAeMROq0iMUX2bzzH9pOttyMcWkwq+HbE5uyuGD82LN7y2q+SNvi/6V5JEsOlD2R1A==`

The wasm file is built from that source by the Pyodide project's own build, using the CPython, Emscripten and library versions
that its `cpython/Makefile` and `Makefile.envs` name. You can obtain the source from the locations above without charge.

## How to check that the release is what it says it is

```sh
pnpm install
pnpm run fetch-upstream   # downloads each file and refuses any whose sha256 differs from upstream/lock.json
pnpm run build            # writes dist/ with module.json, adapter.mjs, the artifacts and SHA256SUMS
```

## The files, as mirrored

| file | what | sha256 | bytes |
| --- | --- | --- | --- |
| pyodide.asm.wasm | Pyodide runtime | `cc36e3cab04fdfc9a63ff13eb52eae2b911bf46c025cc7b281f394bd3de1d5e6` | 9598218 |
| python_stdlib.zip | Pyodide runtime | `fa1957e5777068fc4f7437f96d860ae2fbe9c19732ba06c84e004ec16dd7dd7a` | 2545637 |
| pyodide-lock.json | Pyodide runtime | `5dc2fc119108bc148c7457dc86e7675b5c87e1cafd420b9c34c1eaef7b36c010` | 119077 |
| certifi-2026.4.22-py3-none-any.whl | certifi 2026.4.22 | `c2c0091986db798df5fd84582d289496f31244a898ec032b7015278c2d82c80c` | 135707 |
| charset_normalizer-3.4.7-py3-none-any.whl | charset-normalizer 3.4.7 | `9e437ef92fa51f06eedeb1ef092c0a887bd24fe0d40b1e900191117ce1653121` | 61958 |
| contourpy-1.3.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl | contourpy 1.3.3 | `0ac15ebf9f820d2d1c3526388aa2818b631cb6c4aae1682efd6b4cc12c1f302c` | 118874 |
| cycler-0.12.1-py3-none-any.whl | cycler 0.12.1 | `8ee450085f15b47f78b034d60059af6a3649e98fa5dde073363437742cc0b4ea` | 8321 |
| fonttools-4.62.1-py3-none-any.whl | fonttools 4.62.1 | `0d1516e073fd0a8d8e6d9af46417b6a26209a42518024a18f7085e72d2599605` | 1152647 |
| h11-0.16.0-py3-none-any.whl | h11 0.16.0 | `d920caa25363694bc8de71ba42e5e2bc3353c8df6bcf5025551386e279bca264` | 37515 |
| httpcore-1.0.9-py3-none-any.whl | httpcore 1.0.9 | `27bc91994ad7e21a8333608b8ba5e2b9655ae9d86820d4cefb03dd8db8c5de48` | 78783 |
| httpx-0.28.1-py3-none-any.whl | httpx 0.28.1 | `830cb1ec73bb4c46f2e38ebeb3dd50ffb45f62b804dd040519d34fe36f8fdfc7` | 77457 |
| idna-3.11-py3-none-any.whl | idna 3.11 | `1619419bc899f07c7a608a12e8238e5e0bc15bb25fec90cfe20a86bb849ba0d8` | 71008 |
| kiwisolver-1.5.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl | kiwisolver 1.5.0 | `47781998156721147c128a3c74547d5703e0e3cc454d8203e629339368308a93` | 36616 |
| matplotlib-3.10.8-cp314-cp314-pyemscripten_2026_0_wasm32.whl | matplotlib 3.10.8 | `722857932f8f62eac64f8439af15c94d427f9fb945f9590cd242805c983d2d54` | 6982033 |
| numpy-2.4.6-cp314-cp314-pyemscripten_2026_0_wasm32.whl | numpy 2.4.6 | `a292c1f5d7d8a2208cd5e94fc467604c131cabcd2fc14fed6eefde121e7fabdf` | 2960568 |
| packaging-26.1-py3-none-any.whl | packaging 26.1 | `565acbbea54da30348b6d68b6a54373e6f777987db9f1db6966b4b3a5060d303` | 95852 |
| pandas-3.0.2-cp314-cp314-pyemscripten_2026_0_wasm32.whl | pandas 3.0.2 | `45ff57772cc2f366a8582c7d3097cc4e6676342ecd5a3c08184a43462d5a02ae` | 4177749 |
| pillow-12.2.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl | pillow 12.2.0 | `e29838b7a756e4ee0f27a9cfa9a387ee0dfa2e9dd44be2dd595130b9f9d93ac3` | 1037806 |
| pyparsing-3.3.2-py3-none-any.whl | pyparsing 3.3.2 | `f0dd8225b5f8e945980b400bd465b4b90cb0498a2eede0d9dbea98372f6110c5` | 122781 |
| python_dateutil-2.9.0.post0-py2.py3-none-any.whl | python-dateutil 2.9.0.post0 | `9b13365edf9c188f570baf9c540bbb3029ada2a2dacb9694b3659941693ee9e5` | 229892 |
| pytz-2026.1.post1-py2.py3-none-any.whl | pytz 2026.1.post1 | `b8249d6450146e0b61e6d710dc02ebb35a904796c4c2f97fe87d4ac5872db36a` | 510489 |
| requests-2.33.1-py3-none-any.whl | requests 2.33.1 | `6d62c51c4e7707386bfc2ef54845c16cdaeb99606c064357cccfe4d621285175` | 64947 |
| six-1.17.0-py2.py3-none-any.whl | six 1.17.0 | `228c50f73aa7addf2c2ccf2979c256802a59ab69cad8152b31b9443cc8140f42` | 11050 |
| urllib3-2.6.3-py3-none-any.whl | urllib3 2.6.3 | `86b7c1af060597b115bcde5e36798039ca50b221afe14aa03d3437ac09b02a75` | 131580 |

The wheels are built by the Pyodide project for its WebAssembly platform and published on the Pyodide CDN
(`https://cdn.jsdelivr.net/pyodide/v314.0.7/full/`); the home of each package's source is named in `NOTICES.txt`.
