// The store interface every reader and writer of a tenant's rows is written against. It is the
// part of D1's surface this service uses and nothing more, which is what lets one `D1Database`
// stand where it is asked for: the account's rows stay in D1 while the tenant's move into its own
// Durable Object, and the same function reads either.
//
// The adapter below is throwaway. Phase 3 replaces it with drizzle's `durable-sqlite` driver, so
// nothing here grows into a query layer.

export interface SqlMeta {
  changes: number;
}

export interface SqlResult<T> {
  results: T[];
  success: true;
  meta: SqlMeta;
}

export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
  all<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
  raw<T = unknown[]>(): Promise<T[]>;
}

export interface SqlDb {
  prepare(query: string): SqlStatement;
  batch<T = unknown>(statements: SqlStatement[]): Promise<SqlResult<T>[]>;
}

type Row = Record<string, SqlStorageValue>;

// A statement this adapter built, which is the only kind a batch of it takes. The sync step is what
// `transactionSync` needs: a closure that runs every statement of a batch and returns, so a
// failure past the first rolls the whole of it back the way D1's implicit transaction does.
interface Prepared extends SqlStatement {
  step(): SqlResult<Row>;
}

const isPrepared = (statement: SqlStatement): statement is Prepared =>
  typeof (statement as Partial<Prepared>).step === "function";

const prepared = (statement: SqlStatement): Prepared => {
  if (isPrepared(statement)) return statement;
  throw new Error("a batch takes the statements this store prepared and no others");
};

const bound = (value: unknown): SqlStorageValue => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    const copy = new Uint8Array(value.byteLength);
    copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return copy.buffer;
  }
  throw new Error(`a statement binds no ${typeof value}`);
};

// How far a write reached, which `endSession` and the record commit read as a boolean. SQLite
// counts it as rows written, and every statement whose answer is read that way writes one table
// with no trigger on it.
const metaOf = (cursor: SqlStorageCursor<Row>): SqlMeta => ({ changes: cursor.rowsWritten });

const statement = (storage: DurableObjectStorage, query: string, values: SqlStorageValue[]): Prepared => {
  const step = (): SqlResult<Row> => {
    const cursor = storage.sql.exec<Row>(query, ...values);
    const results = cursor.toArray();
    return { results, success: true, meta: metaOf(cursor) };
  };
  // SQLite answers here and now, and D1 answers over the network. These are async so that a
  // refused statement rejects rather than throwing out of the call, which is what every caller's
  // `.catch` and every `await` around a batch is written against.
  return {
    step,
    bind: (...next: unknown[]): SqlStatement => statement(storage, query, next.map(bound)),
    // The row shapes are the caller's assertion here exactly as they are on D1: `.all<Row>()` names
    // what the columns are and the store does not check it.
    all: async <T>(): Promise<SqlResult<T>> => step() as unknown as SqlResult<T>,
    run: async <T>(): Promise<SqlResult<T>> => step() as unknown as SqlResult<T>,
    first: async <T>(): Promise<T | null> => (step().results[0] ?? null) as T | null,
    raw: async <T>(): Promise<T[]> => [...storage.sql.exec<Row>(query, ...values).raw()] as T[],
  };
};

export const tenantSql = (storage: DurableObjectStorage): SqlDb => ({
  prepare: (query: string): SqlStatement => statement(storage, query, []),
  // D1's batch is one implicit transaction, so this is one too: a statement that fails takes every
  // statement beside it back with it.
  batch: async <T>(statements: SqlStatement[]): Promise<SqlResult<T>[]> => {
    const steps = statements.map(prepared);
    return storage.transactionSync(() => steps.map((one) => one.step())) as unknown as SqlResult<T>[];
  },
});
