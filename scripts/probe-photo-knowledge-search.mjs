import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ArkKnowledgeSearch } from '../apps/api/src/knowledge/providers.js';

// Read-only diagnostic: no Feishu messages, confirmation, or knowledge writes.
const [draftFile, outputDirectory, ...ids] = process.argv.slice(2);
if (!draftFile || !outputDirectory) throw new Error('Supply a saved draft and an isolated output directory, optionally item IDs.');
const draft = JSON.parse(await readFile(draftFile, 'utf8'));
const original = draft.versions.at(-1).content;
const content = { ...original, items: ids.length ? original.items.filter(i => ids.includes(i.id)) : original.items };
if (!content.items.length) throw new Error('No matching items');
await mkdir(outputDirectory, { recursive: true });
const started = Date.now();
const transport = {};
const search = new ArkKnowledgeSearch({ fetchImpl: async (url, options) => {
  // Never record request headers, credentials, or full error bodies.
  try {
    const response = await fetch(url, options);
    transport.httpStatus = response.status;
    const payload = await response.clone().json();
    transport.providerStatus = payload.status;
    transport.providerErrorCode = payload.error?.code;
    if (response.ok) await writeFile(path.join(outputDirectory, 'response.json'), JSON.stringify(payload, null, 2));
    return response;
  } catch (error) {
    transport.errorName = error.name;
    transport.causeCode = error.cause?.code;
    throw error;
  }
} });
const summary = { sourceDraftId: draft.id, itemIds: content.items.map(i => i.id), startedAt: new Date(started).toISOString(), published: false };
try {
  const result = await search.verify(content);
  await writeFile(path.join(outputDirectory, 'verification.json'), JSON.stringify(result, null, 2));
  Object.assign(summary, { status: 'completed', calls: result.calls.length, verified: result.checks.filter(c => c.status !== 'unresolved').length, unresolved: result.checks.filter(c => c.status === 'unresolved').length });
} catch (error) {
  Object.assign(summary, { status: 'failed', code: error.name === 'TimeoutError' ? 'search_timeout' : error.message });
  process.exitCode = 1;
}
Object.assign(summary, { elapsedMs: Date.now() - started, transport });
await writeFile(path.join(outputDirectory, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
