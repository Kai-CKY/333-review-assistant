import Database from 'better-sqlite3';
import { readFile } from 'node:fs/promises';

export const isSqliteFile = file => /\.(sqlite|db)$/i.test(file);

export function readRows(db) {
  const data = {};
  for (const { name, shape } of db.prepare('SELECT name,shape FROM collections').all()) {
    const values = db.prepare('SELECT value FROM records WHERE collection=? ORDER BY position').all(name).map(r => JSON.parse(r.value));
    data[name] = shape === 'array' ? values : values[0];
  }
  return data;
}

// A read transaction includes WAL contents and never normalizes or changes learning data.
export async function readDatabaseFile(file) {
  if (!isSqliteFile(file)) return JSON.parse(await readFile(file, 'utf8'));
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try { return db.transaction(() => readRows(db))(); } finally { db.close(); }
}
