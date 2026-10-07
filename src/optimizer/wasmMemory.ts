/**
 * Making the optimizer's WebAssembly module run without shared memory.
 *
 * fsrs-browser is built for threads, so its module imports a *shared* memory, and
 * its loader creates one. Shared memory needs `SharedArrayBuffer` underneath, which a
 * browser only grants a cross-origin-isolated page — and Android's WebView supports
 * no cross-origin isolation at all. The plugin runs the optimizer on one thread and
 * never shares the memory, so the module is rewritten to import an ordinary one:
 * the import's limits flag drops its "shared" bit. Atomic instructions stay valid on
 * unshared memory, and with a single thread nothing ever waits on one.
 */

/** Section id of the import section, and the import kinds, from the wasm binary format. */
const IMPORT_SECTION = 2;
const KIND_FUNC = 0;
const KIND_TABLE = 1;
const KIND_MEMORY = 2;
const KIND_GLOBAL = 3;
const KIND_TAG = 4;
/** Limits flags: bit 0 says a maximum follows, bit 1 says the memory is shared. */
const FLAG_HAS_MAX = 0x01;
const FLAG_SHARED = 0x02;

/**
 * A copy of `bytes` whose imported memory is not shared. Throws when the module
 * imports no memory, or one that is not shared — either means the module is not the
 * one this was written for, and running it anyway would fail somewhere less clear.
 */
export function unshareImportedMemory(bytes: Uint8Array): Uint8Array {
  let pos = 8; // magic and version
  const byte = (): number => {
    const value = bytes[pos];
    if (value === undefined) throw new Error("wasm: unexpected end of module");
    pos += 1;
    return value;
  };
  const leb = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = byte();
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
    }
  };
  /** Skip a limits record and say where its flag byte was. */
  const limits = (): number => {
    const at = pos;
    const flags = byte();
    leb();
    if (flags & FLAG_HAS_MAX) leb();
    return at;
  };

  while (pos < bytes.length) {
    const id = byte();
    const size = leb();
    const end = pos + size;
    if (id === IMPORT_SECTION) {
      const count = leb();
      for (let i = 0; i < count; i++) {
        const moduleName = leb();
        pos += moduleName;
        const fieldName = leb();
        pos += fieldName;
        const kind = byte();
        if (kind === KIND_FUNC) leb();
        else if (kind === KIND_TABLE) {
          byte();
          limits();
        } else if (kind === KIND_MEMORY) {
          const at = limits();
          const flags = bytes[at] ?? 0;
          if ((flags & FLAG_SHARED) === 0) throw new Error("wasm: imported memory is not shared");
          const copy = bytes.slice();
          copy[at] = flags & ~FLAG_SHARED;
          return copy;
        } else if (kind === KIND_GLOBAL) {
          byte();
          byte();
        } else if (kind === KIND_TAG) {
          byte();
          leb();
        } else throw new Error(`wasm: unknown import kind ${kind.toString()}`);
      }
    }
    pos = end;
  }
  throw new Error("wasm: module imports no memory");
}
