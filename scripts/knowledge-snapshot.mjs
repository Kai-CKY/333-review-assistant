import path from 'node:path';
import { exportKnowledge, restoreKnowledge } from '../apps/api/src/knowledge/snapshot.js';
import { mergeKnowledge } from '../apps/api/src/knowledge/merge.js';

const [action, ...args] = process.argv.slice(2);
const value = flag => { const at = args.indexOf(flag); return at < 0 ? undefined : args[at + 1]; };
const snapshotDir = path.resolve(value('--snapshot') || '.data/knowledge-export');
const databaseFile = path.resolve(value('--database') || process.env.DATA_FILE || '.data/review-assistant.json');
try {
  let result;
  if (action === 'export') result = await exportKnowledge({ databaseFile, outputDir: snapshotDir });
  else if (action === 'merge') {
    if (!value('--database') && !process.env.DATA_FILE) throw new Error('Specify the existing target database with --database or DATA_FILE.');
    result = await mergeKnowledge({ snapshotDir, databaseFile, apply: args.includes('--apply'), serverStopped: args.includes('--server-stopped'), allowStructuredUpgrade: args.includes('--allow-structured-upgrade') });
    if (result.conflicts.length) process.exitCode = 2;
  }
  else if (action === 'restore') {
    if (!value('--database') && !process.env.DATA_FILE) throw new Error('Specify a new destination with --database or DATA_FILE; stop its server before restoring.');
    result = await restoreKnowledge({ snapshotDir, databaseFile });
  } else throw new Error('Use export, restore or merge, optionally --snapshot DIRECTORY and --database FILE.');
  console.log(JSON.stringify({ action, ...result, snapshotDir, databaseFile, gitCommitCreated: false }));
} catch (error) { console.error(error.message); process.exitCode = 1; }
