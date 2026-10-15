/**
 * The bot's whole persistent state: one SQLite file, opened once at startup.
 * It holds nothing but which copies of the app are linked to whom.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { MIGRATIONS } from './migrations.ts';
import { log } from './log.ts';

export type Database = DatabaseSync;

export function openDatabase(path: string): Database {
  const full = resolve(path);
  mkdirSync(dirname(full), { recursive: true });

  const db = new DatabaseSync(full);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  migrate(db);
  log.info(`database ready at ${full}`);
  return db;
}

function migrate(db: Database): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const applied = row?.user_version ?? 0;

  if (applied > MIGRATIONS.length) {
    throw new Error(
      `database is at schema version ${applied}, but this build only knows ${MIGRATIONS.length}. ` +
        'Deploy the newer build, or restore an older copy of the database.',
    );
  }

  for (let index = applied; index < MIGRATIONS.length; index += 1) {
    const migration = MIGRATIONS[index];
    if (!migration) continue;

    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${index + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${migration.name} failed`, { cause: error });
    }
    log.info(`migration applied: ${migration.name}`);
  }
}
