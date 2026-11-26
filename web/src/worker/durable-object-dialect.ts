// A Kysely dialect over a Durable Object's SQLite storage, so Better Auth's
// Kysely adapter can keep its tables there. Better Auth has dialects for D1,
// Node's and Bun's SQLite, but not this one. It's the D1 dialect Better Auth
// ships, with the Durable Object's synchronous `sql.exec` in place of D1's
// prepared statements.

import {
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryResult,
} from "kysely";

export class DurableObjectDialect implements Dialect {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
  }

  createAdapter() {
    return new SqliteAdapter();
  }

  createDriver(): Driver {
    return new DurableObjectDriver(this.#sql);
  }

  createQueryCompiler() {
    return new SqliteQueryCompiler();
  }

  // oxlint-disable-next-line typescript/no-explicit-any -- Kysely's own signature
  createIntrospector(db: Kysely<any>) {
    return new SqliteIntrospector(db);
  }
}

/**
 * One connection, the storage itself. A Durable Object has no interactive
 * transactions (only `transactionSync` around synchronous code), so Better
 * Auth is told not to use them, as it is for D1.
 */
class DurableObjectDriver implements Driver {
  readonly #connection: DatabaseConnection;

  constructor(sql: SqlStorage) {
    this.#connection = new DurableObjectConnection(sql);
  }

  async init() {}

  acquireConnection() {
    return Promise.resolve(this.#connection);
  }

  beginTransaction(): Promise<void> {
    throw new Error("Durable Object storage has no interactive transactions");
  }

  commitTransaction(): Promise<void> {
    throw new Error("Durable Object storage has no interactive transactions");
  }

  rollbackTransaction(): Promise<void> {
    throw new Error("Durable Object storage has no interactive transactions");
  }

  async releaseConnection() {}

  async destroy() {}
}

class DurableObjectConnection implements DatabaseConnection {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
  }

  executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    const cursor = this.#sql.exec(query.sql, ...query.parameters);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- rows are the query's
    const rows = cursor.toArray() as R[];
    // SQLite's own count, as D1's meta.changes is: the cursor's rowsWritten
    // also counts each index entry written.
    const { changes } = this.#sql.exec<{ changes: number }>("SELECT changes() AS changes").one();
    return Promise.resolve({ rows, numAffectedRows: BigInt(changes) });
  }

  // Better Auth never streams
  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("Durable Object storage doesn't stream queries");
  }
}
