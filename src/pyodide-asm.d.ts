/** The Emscripten factory the bundle imports so that Pyodide never has to `import()` it (see src/python-loader.ts). */
declare module "pyodide/pyodide.asm.mjs" {
  import type { loadPyodide } from "pyodide";
  const createPyodideModule: NonNullable<NonNullable<Parameters<typeof loadPyodide>[0]>["createPyodideModule"]>;
  export default createPyodideModule;
}
