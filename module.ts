import { defineModule } from "@oxidevm/sdk/wasm";
import { loadPyodide } from "pyodide";
import createPyodideModule from "pyodide/pyodide.asm.mjs";

export default defineModule({
  manifest: {
    id: "pyodide",
    version: "0.1.0",
    abi: "emscripten",
    artifacts: [],
    process: { kind: "command" },
    requires: { host: ["files.sync"] },
    license: { spdx: "MPL-2.0" },
  },
  adapter: host => ({ main: () => { void loadPyodide; void createPyodideModule; return host.fail(2, "x"); } }),
});
