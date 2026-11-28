import { DatabaseSync } from 'node:sqlite';

const MAX_CACHED_STATEMENTS = 128;

// The DSH runtime supplies SQLite and FTS5. Match the better-sqlite3 helpers
// used by the shared daemon without shipping a Node/Electron ABI-specific addon,
// and cache prepared statements + top-level transactions so multi-thousand-file
// FTS sweeps don't recompile SQLite bytecode on every file.
export default class PluginDatabase extends DatabaseSync {
  #sequence = 0;
  #txDepth = 0;
  #statements = new Map();
  #beginStmt = null;
  #commitStmt = null;
  #rollbackStmt = null;

  prepare(sql) {
    const cached = this.#statements.get(sql);
    if (cached) {
      this.#statements.delete(sql);
      this.#statements.set(sql, cached);
      return cached;
    }
    const stmt = super.prepare(sql);
    this.#statements.set(sql, stmt);
    if (this.#statements.size > MAX_CACHED_STATEMENTS) {
      const oldest = this.#statements.keys().next().value;
      if (oldest !== undefined) this.#statements.delete(oldest);
    }
    return stmt;
  }

  pragma(statement) {
    return this.prepare('PRAGMA ' + statement).all();
  }

  transaction(body) {
    return (...args) => {
      if (this.#txDepth === 0) {
        this.#beginStmt ??= super.prepare('BEGIN IMMEDIATE');
        this.#commitStmt ??= super.prepare('COMMIT');
        this.#rollbackStmt ??= super.prepare('ROLLBACK');
        this.#txDepth++;
        this.#beginStmt.run();
        try {
          const value = body(...args);
          this.#commitStmt.run();
          return value;
        } catch (error) {
          try { this.#rollbackStmt.run(); } catch { /* already rolled back */ }
          throw error;
        } finally {
          this.#txDepth--;
        }
      }

      const savepoint = 'molio_tx_' + ++this.#sequence;
      this.#txDepth++;
      this.exec('SAVEPOINT ' + savepoint);
      try {
        const value = body(...args);
        this.exec('RELEASE ' + savepoint);
        return value;
      } catch (error) {
        this.exec('ROLLBACK TO ' + savepoint);
        this.exec('RELEASE ' + savepoint);
        throw error;
      } finally {
        this.#txDepth--;
      }
    };
  }

  close() {
    this.#statements.clear();
    this.#beginStmt = null;
    this.#commitStmt = null;
    this.#rollbackStmt = null;
    return super.close();
  }
}
