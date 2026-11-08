import { getTableColumns, getTableName } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { toBytes } from "./schema/columns";

// One id for one row, computed the same way out of either store, so that what crossed from D1 into
// an account's own object can be held against what D1 holds rather than counted. A count cannot
// carry it: the object writes its own rows into these tables after the cutover, so a table it has
// outgrown D1 on reads as arrived whether or not a single D1 row was ever written to it.
//
// The id is a version 5 uuid: SHA-1 over a fixed namespace and the row written out below. SHA-1 is
// not standing between anybody and anything here — the two sides are the same code reading two
// copies of one table — and `crypto.subtle` has it, so nothing is added to the dependency tree for
// it.

// The namespace every id the session copy hangs off, a constant of this copier. The two stores
// have to compute one id for one row, so a namespace that could differ between them would be a
// difference the comparison reads as a row that did not arrive.
const NAMESPACE = "9f2c6a84-5b31-4d0e-8c77-1ae4b2f60d93";

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const bytesOfUuid = (uuid: string): Uint8Array => {
  const pairs = uuid.replace(/-/g, "").match(/../g);
  if (pairs === null || pairs.length !== 16) throw new Error(`${uuid} is not a uuid`);
  return Uint8Array.from(pairs, (pair) => Number.parseInt(pair, 16));
};

// One value, tagged by what it is and prefixed by how long it runs. The length is the whole of why
// this is unambiguous: no character has to be forbidden in a value and no separator has to be
// trusted not to appear in one, so two rows that differ cannot be written out the same way.
//
// That is the failure worth designing against. Two sides that serialise differently match nothing
// at all, which reads as a serialiser fault the moment anybody looks; two different rows that
// collapse to one id hide a row that never crossed, and the comparison would report the copy
// sound. `../session-copy` holds the id set of each table against its row count for that reason.
const encoded = (value: unknown): string => {
  if (value === null || value === undefined) return "z:0:";
  if (typeof value === "string") return `s:${value.length}:${value}`;
  if (typeof value === "boolean") return `b:1:${value ? "1" : "0"}`;
  if (typeof value === "number" || typeof value === "bigint") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`a row holds ${String(value)} where a number belongs`);
    }
    // `String` writes one text for one value, and `-0` comes out as `0`, which is what SQLite
    // would hand back for it either way.
    const text = String(value);
    return `n:${text.length}:${text}`;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value) || Array.isArray(value)) {
    const text = hex(toBytes(value));
    return `x:${text.length}:${text}`;
  }
  throw new Error(`a row holds a ${typeof value}, which has no encoding here`);
};

// The row written out: the table it belongs to, then every column of it the comparison reads, by
// the name and in the order the schema gives them rather than the order a driver returned them.
// Both schemas name these columns identically — they are two declarations of one table — so one
// row read out of either store is written out the same way.
//
// `only`, where it is given, is the SQL names of the columns that identify the row. A table whose
// object-side row deliberately wins on a session both stores held is compared on those alone: its
// content differs by design there, and a whole-row id would read that as a row that did not
// arrive.
export const rowName = (table: SQLiteTable, row: Record<string, unknown>, only: ReadonlySet<string> | null): string => {
  const columns = Object.entries(getTableColumns(table))
    .map(([field, column]) => ({ field, name: column.name }))
    .filter((column) => only === null || only.has(column.name))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  if (only !== null && columns.length !== only.size) {
    throw new Error(`${getTableName(table)} does not carry every column the comparison identifies it by`);
  }
  const name = getTableName(table);
  const written = columns.map((column) => `${column.name.length}:${column.name}=${encoded(row[column.field])}`);
  return [`${name.length}:${name}`, ...written].join("|");
};

// SHA-1 of the namespace bytes and the name, with the version and variant bits set, which is what
// RFC 4122 calls a version 5 uuid.
export const uuidV5 = async (name: string): Promise<string> => {
  const namespace = bytesOfUuid(NAMESPACE);
  const text = new TextEncoder().encode(name);
  const input = new Uint8Array(namespace.length + text.length);
  input.set(namespace);
  input.set(text, namespace.length);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-1", input)).slice(0, 16);
  const version = bytes[6];
  const variant = bytes[8];
  if (version === undefined || variant === undefined) throw new Error("SHA-1 answered fewer than sixteen bytes");
  bytes[6] = (version & 0x0f) | 0x50;
  bytes[8] = (variant & 0x3f) | 0x80;
  const digits = hex(bytes);
  return [digits.slice(0, 8), digits.slice(8, 12), digits.slice(12, 16), digits.slice(16, 20), digits.slice(20)].join(
    "-",
  );
};

export const rowUuid = (
  table: SQLiteTable,
  row: Record<string, unknown>,
  only: ReadonlySet<string> | null,
): Promise<string> => uuidV5(rowName(table, row, only));
