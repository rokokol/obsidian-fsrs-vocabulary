/** Human-readable message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The plural "s" for a count, for notices that read as sentences. */
export function plural(count: number): string {
  return count === 1 ? "" : "s";
}

/**
 * A random id: ten base-36 characters, about 51 random bits — short enough for a
 * table cell or a file name, with nothing in it that JSON or a path escapes.
 */
export function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value.toString(36).padStart(10, "0").slice(-10);
}

/** Whether a stored value is an id `randomId` could have made, or a shorter hand-made one. */
export function isRandomId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]{1,32}$/.test(value);
}
