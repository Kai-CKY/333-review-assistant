import path from 'node:path';
import { backupRuntime, restoreRuntime } from '../apps/api/src/storage/runtime-backup.js';
const [command, ...args] = process.argv.slice(2);
function value(name) { const i = args.indexOf(name); if (i < 0 || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing ${name}`); return path.resolve(args[i + 1]); }
if (command === 'backup') console.log(JSON.stringify(await backupRuntime({ databaseFile: value('--source'), outputDir: value('--output'), serverStopped: args.includes('--server-stopped') }), null, 2));
else if (command === 'restore') console.log(JSON.stringify(await restoreRuntime({ backupDir: value('--source'), outputDir: value('--output'), sqlite: !args.includes('--json') }), null, 2));
else throw new Error('Use backup|restore --source PATH --output NEW_DIRECTORY. Backup requires --server-stopped.');
