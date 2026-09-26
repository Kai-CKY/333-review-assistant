import { LocalRepository } from '../repository.js';
export async function openRepository(filePath, options) {
  if (/\.(sqlite|db)$/i.test(filePath)) {
    const { SqliteRepository } = await import('./sqlite-repository.js');
    return new SqliteRepository(filePath, options);
  }
  return new LocalRepository(filePath, options);
}
