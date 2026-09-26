import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteRepository } from '../apps/api/src/storage/sqlite-repository.js';
import { readDatabaseFile } from '../apps/api/src/storage/database-file.js';
import { libraryPolicy, syncSavedKnowledge } from '../apps/api/src/knowledge/library.js';
const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
const dataset = JSON.parse(await readFile(args.includes('--dataset') ? value('--dataset') : 'apps/api/test/fixtures/retrieval-synthetic.json', 'utf8'));
if (!Array.isArray(dataset.cases) || !dataset.cases.length) throw new Error('Dataset requires labeled cases.');
let points = dataset.points;
if (args.includes('--database')) {
  const data = await readDatabaseFile(path.resolve(value('--database')));
  syncSavedKnowledge(data, libraryPolicy()); points = data.knowledgePoints;
}
if (!Array.isArray(points)) throw new Error('Provide dataset points or --database.');
const scale = args.includes('--scale') ? Number(value('--scale')) : 0;
if (!Number.isSafeInteger(scale) || scale < 0 || scale > 100000) throw new Error('Scale must be 0–100000.');
points = [...points, ...Array.from({ length: scale }, (_, i) => ({ id: `synthetic-${i}`, title: `无关样本 ${i}`, text: '用于容量回归的独立片段，不能当成教材内容。'.repeat(20), sourceScopeKey: 'class-a', materialKind: 'textbook' }))];
const folder = await mkdtemp(path.join(tmpdir(), '333-retrieval-eval-'));
const repository = new SqliteRepository(path.join(folder, 'evaluation.sqlite'));
try {
  const buildStart = performance.now(); await repository.save({ knowledgePoints: points }); const buildMs = performance.now() - buildStart;
  const results = [];
  for (const c of dataset.cases) {
    const start = performance.now(), hits = await repository.searchPoints(c.query, { scopeKey: c.scopeKey, textbookOnly: c.textbookOnly, limit: 5 });
    const ids = hits.map(h => h.id), passed = c.noMatch ? ids.length === 0 : c.expectedIds?.some(id => ids.includes(id));
    results.push({ query: c.query, ids, passed: Boolean(passed), durationMs: +(performance.now() - start).toFixed(2), noMatch: Boolean(c.noMatch) });
  }
  const answerable = results.filter(r => !r.noMatch), negatives = results.filter(r => r.noMatch), timings = results.map(r => r.durationMs).sort((a,b) => a-b);
  const report = { kind: dataset.kind || 'unclassified_dataset', note: dataset.description, generatedAt: new Date().toISOString(), engine: 'sqlite-fts5-presegmented-v1',
    points: points.length, buildMs: +buildMs.toFixed(2), top5Recall: answerable.filter(r => r.passed).length / (answerable.length || 1),
    negativeCases: negatives.length, negativeFailures: negatives.filter(r => !r.passed).length, queryP95Ms: timings[Math.ceil(timings.length * .95) - 1], results };
  if (args.includes('--output')) await writeFile(value('--output'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); if (results.some(r => !r.passed)) process.exitCode = 1;
} finally { repository.close(); await rm(folder, { recursive: true, force: true }); }
