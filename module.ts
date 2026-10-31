import { defineModule } from "@oxidevm/sdk/wasm";
import { createCommand } from "./src/command.ts";

export default defineModule({
  manifest: {
    id: "pyodide",
    version: "0.1.0",
    abi: "emscripten",
    artifacts: [
      { name: "pyodide.asm.wasm", from: "upstream/pyodide.asm.wasm" },
      { name: "python_stdlib.zip", from: "upstream/python_stdlib.zip" },
      { name: "pyodide-lock.json", from: "upstream/pyodide-lock.json" },
      { name: "contourpy-1.3.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl", from: "upstream/contourpy-1.3.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl" },
      { name: "cycler-0.12.1-py3-none-any.whl", from: "upstream/cycler-0.12.1-py3-none-any.whl" },
      { name: "fonttools-4.62.1-py3-none-any.whl", from: "upstream/fonttools-4.62.1-py3-none-any.whl" },
      { name: "kiwisolver-1.5.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl", from: "upstream/kiwisolver-1.5.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl" },
      { name: "matplotlib-3.10.8-cp314-cp314-pyemscripten_2026_0_wasm32.whl", from: "upstream/matplotlib-3.10.8-cp314-cp314-pyemscripten_2026_0_wasm32.whl" },
      { name: "numpy-2.4.6-cp314-cp314-pyemscripten_2026_0_wasm32.whl", from: "upstream/numpy-2.4.6-cp314-cp314-pyemscripten_2026_0_wasm32.whl" },
      { name: "packaging-26.1-py3-none-any.whl", from: "upstream/packaging-26.1-py3-none-any.whl" },
      { name: "pandas-3.0.2-cp314-cp314-pyemscripten_2026_0_wasm32.whl", from: "upstream/pandas-3.0.2-cp314-cp314-pyemscripten_2026_0_wasm32.whl" },
      { name: "pillow-12.2.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl", from: "upstream/pillow-12.2.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl" },
      { name: "pyparsing-3.3.2-py3-none-any.whl", from: "upstream/pyparsing-3.3.2-py3-none-any.whl" },
      { name: "python_dateutil-2.9.0.post0-py2.py3-none-any.whl", from: "upstream/python_dateutil-2.9.0.post0-py2.py3-none-any.whl" },
      { name: "pytz-2026.1.post1-py2.py3-none-any.whl", from: "upstream/pytz-2026.1.post1-py2.py3-none-any.whl" },
      { name: "six-1.17.0-py2.py3-none-any.whl", from: "upstream/six-1.17.0-py2.py3-none-any.whl" },
      { name: "NOTICES.txt", from: "NOTICES.txt" },
      { name: "SOURCE-OFFER.md", from: "SOURCE-OFFER.md" },
    ],
    process: { kind: "command" },
    requires: {
      host: ["files.async", "files.sync", "process.info", "process.spawn", "sockets.connect"],
      browser: ["cross-origin-isolated", "jspi"],
    },
    options: {
      packages: {
        type: "enum-set",
        values: ["contourpy", "cycler", "fonttools", "kiwisolver", "matplotlib", "numpy", "packaging", "pandas", "pillow", "pyparsing", "python-dateutil", "pytz", "six"],
        default: ["pandas", "matplotlib"],
      },
    },
    license: {
      spdx: "Apache-2.0 AND MPL-2.0 AND PSF-2.0 AND BSD-3-Clause AND MIT AND MIT-CMU AND 0BSD AND Zlib AND CC0-1.0 AND OFL-1.1 AND Bitstream-Vera AND LicenseRef-Matplotlib",
      notices: ["NOTICES.txt", "SOURCE-OFFER.md"],
      source: "https://github.com/pyodide/pyodide/tree/314.0.7",
    },
  },
  adapter: host => createCommand(host),
});
