import { describe, expect, it } from "vitest";
import { unshareImportedMemory } from "../src/optimizer/wasmMemory";

/** A module that only imports a memory `m.e` with the given limits flags (min 1, max 1). */
function moduleImportingMemory(flags: number): Uint8Array {
  const entry = [1, 0x6d, 1, 0x65, 2, flags, 1, 1]; // "m" "e" memory {flags, 1, 1}
  const section = [1, ...entry];
  return Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 2, section.length, ...section]);
}

const SHARED = 0x03;
const UNSHARED = 0x01;

describe("unshareImportedMemory", () => {
  it("turns a shared memory import into an ordinary one", () => {
    const shared = moduleImportingMemory(SHARED);
    const patched = unshareImportedMemory(shared);
    expect(patched).toEqual(moduleImportingMemory(UNSHARED));
    // The original is left alone: the bundled bytes are read again on the next load.
    expect(shared).toEqual(moduleImportingMemory(SHARED));
  });

  it("gives a module that links against unshared memory, which the original does not", async () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
    const imports = { m: { e: memory } };
    await expect(WebAssembly.instantiate(moduleImportingMemory(SHARED), imports)).rejects.toThrow();
    await expect(
      WebAssembly.instantiate(unshareImportedMemory(moduleImportingMemory(SHARED)), imports),
    ).resolves.toBeDefined();
  });

  it("refuses a module that is not the one it was written for", () => {
    expect(() => unshareImportedMemory(moduleImportingMemory(UNSHARED))).toThrow(/not shared/);
    expect(() => unshareImportedMemory(Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))).toThrow(
      /no memory/,
    );
  });
});
