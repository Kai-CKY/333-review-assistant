import { readFile, writeFile } from 'node:fs/promises';
import { ArkKnowledgeSearch } from '../apps/api/src/knowledge/providers.js';

// Reuses already recognized text: no extra vision calls and no publication.
const file = '.data/knowledge-test/latest-draft.json';
const draft = JSON.parse(await readFile(file, 'utf8'));
const started = Date.now();
try {
  const result = await new ArkKnowledgeSearch().verify(draft.versions.at(-1).content);
  await writeFile('.data/knowledge-test/search-recheck.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ status: 'ok', calls: result.calls.length, supported: result.checks.filter(c => c.status !== 'unresolved').length, unresolved: result.checks.filter(c => c.status === 'unresolved').length, elapsedMs: Date.now() - started }));
} catch (error) {
  console.log(JSON.stringify({ status: 'failed', code: error.message, elapsedMs: Date.now() - started }));
  process.exitCode = 1;
}
