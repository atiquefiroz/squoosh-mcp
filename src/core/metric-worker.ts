// SSIMULACRA 2 worker. Self-contained (no local imports) so it runs from dist/*.js and,
// through Node's type stripping, from src/*.ts in tests.
import { parentPort, workerData } from 'node:worker_threads';

interface Ssim2Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  ref_new(ptr: number, width: number, height: number, channels: number): number;
  ref_compare(ref: number, ptr: number, width: number, height: number, channels: number): number;
  ref_free(ref: number): void;
}

interface Request {
  seq: number;
  op: 'ref' | 'cmp' | 'free';
  id: number;
  data?: Uint8Array;
  width?: number;
  height?: number;
  channels?: number;
}

const wasm = new WebAssembly.Instance(workerData.module as WebAssembly.Module, {}).exports as unknown as Ssim2Exports;
const refs = new Map<number, number>();

function withPixels<T>(data: Uint8Array, fn: (ptr: number) => T): T {
  const ptr = wasm.alloc(data.length);
  try {
    new Uint8Array(wasm.memory.buffer, ptr, data.length).set(data);
    return fn(ptr);
  } finally {
    wasm.dealloc(ptr, data.length);
  }
}

parentPort!.on('message', (m: Request) => {
  try {
    let value = 0;
    if (m.op === 'ref') {
      const handle = withPixels(m.data!, (ptr) => wasm.ref_new(ptr, m.width!, m.height!, m.channels!));
      if (!handle) throw new Error('Invalid reference image for SSIMULACRA 2.');
      refs.set(m.id, handle);
    } else if (m.op === 'cmp') {
      const handle = refs.get(m.id);
      if (!handle) throw new Error('Unknown SSIMULACRA 2 reference.');
      value = withPixels(m.data!, (ptr) => wasm.ref_compare(handle, ptr, m.width!, m.height!, m.channels!));
      if (value < -1e8) throw new Error('SSIMULACRA 2 could not score this image (dimension mismatch?).');
    } else {
      const handle = refs.get(m.id);
      if (handle) wasm.ref_free(handle);
      refs.delete(m.id);
      value = wasm.memory.buffer.byteLength;
    }
    parentPort!.postMessage({ seq: m.seq, value });
  } catch (error) {
    parentPort!.postMessage({ seq: m.seq, error: error instanceof Error ? error.message : String(error) });
    // A trap (out of memory, abort) leaves the instance unusable: let the pool replace this worker.
    if (error instanceof WebAssembly.RuntimeError) process.exit(1);
  }
});
