import { DatabaseSync } from 'node:sqlite';

// The DSH runtime supplies SQLite and FTS5. Match the two better-sqlite3 helpers
// used by the shared daemon without shipping a Node/Electron ABI-specific addon.
export default class PluginDatabase extends DatabaseSync {
  #sequence = 0;
  pragma(statement) {
    return this.prepare('PRAGMA ' + statement).all();
  }
  transaction(body) {
    return (...args) => {
      const savepoint = 'molio_tx_' + ++this.#sequence;
      this.exec('SAVEPOINT ' + savepoint);
      try {
        const value = body(...args);
        this.exec('RELEASE ' + savepoint);
        return value;
      } catch (error) {
        this.exec('ROLLBACK TO ' + savepoint);
        this.exec('RELEASE ' + savepoint);
        throw error;
      }
    };
  }
}
