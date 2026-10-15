/**
 * Schema steps, applied in order and tracked with SQLite's `user_version`.
 *
 * Append-only: once a migration has shipped it is never edited, because a
 * database out there has already run it. A change is a new entry.
 */

export interface Migration {
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    name: '001_app_link',
    sql: `
      -- One row per linked copy of the suite. Only a hash of the token is
      -- kept, so a copy of this file is not a set of logins.
      CREATE TABLE app_link (
        token_hash   TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL,
        user_name    TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      );
      CREATE INDEX app_link_by_user ON app_link (user_id);
    `,
  },
];
