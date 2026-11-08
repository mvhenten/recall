import { customType } from "drizzle-orm/sqlite-core";

// A quantized int8 vector, byte for byte. D1 hands a blob back as an ArrayBuffer and the Durable
// Object's SQLite as one too, but a miniflare build has handed back a number array, so the read
// side takes whatever the driver gives and the write side always binds an ArrayBuffer of its own.
export const toBytes = (value: unknown): Uint8Array => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new Error("embedding column is not a blob");
};

// Both stores bind a blob as an ArrayBuffer and neither takes a view of one, so a vector is copied
// out of whatever buffer it was cut from before it is bound.
export const blobOf = (bytes: Uint8Array): ArrayBufferLike => bytes.slice().buffer;

export const vector = customType<{ data: Uint8Array; driverData: ArrayBufferLike }>({
  dataType: () => "blob",
  toDriver: blobOf,
  fromDriver: (value: ArrayBufferLike): Uint8Array => toBytes(value),
});
