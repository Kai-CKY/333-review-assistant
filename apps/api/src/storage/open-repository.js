import { LocalRepository } from '../repository.js';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
export async function openRepository(filePath, options) {
  if (/\.(sqlite|db)$/i.test(filePath)) {
    const { default: Database } = await import('better-sqlite3');
    mkdirSync(path.dirname(filePath), { recursive: true });
    const probe = new Database(filePath);
    const relational = Boolean(probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_points'").get());
    probe.close();
    if (relational || process.env.DATA_FORMAT === 'relational-v1') {
      const { RelationalRepository } = await import('./relational-repository.js');
      return new RelationalRepository(filePath, options);
    }
    const { SqliteRepository } = await import('./sqlite-repository.js');
    return new SqliteRepository(filePath, options);
  }
  return new LocalRepository(filePath, options);
}
