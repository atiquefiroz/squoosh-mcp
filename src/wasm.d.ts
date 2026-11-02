// The subset of the WebAssembly JS API used here. Node has it at runtime, but
// @types/node 22 does not declare it and we avoid pulling in the DOM lib for it.
declare namespace WebAssembly {
  class Module {}
  class Memory {
    readonly buffer: ArrayBuffer;
  }
  class Instance {
    constructor(module: Module, imports?: Record<string, unknown>);
    readonly exports: Record<string, unknown>;
  }
  class RuntimeError extends Error {}
  function compile(bytes: BufferSource | Uint8Array): Promise<Module>;
}
type BufferSource = ArrayBufferView | ArrayBuffer;
