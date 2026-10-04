import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../apps/api/test/helpers/http-server.js';
import { openRepository } from '../apps/api/src/storage/open-repository.js';
import { RelationalRepository } from '../apps/api/src/storage/relational-repository.js';
import { createSeedData } from '../apps/api/src/repository.js';

assert.match(process.version, /^v20\./);
assert.equal(process.platform, 'linux');
assert.equal(existsSync('/app/apps/pdf-parser'), false);
const folder = await mkdtemp(path.join(tmpdir(), '333-release-smoke-'));
const checks = [];
try {
  for (const extension of ['json', 'sqlite', 'relational']) {
    const file = path.join(folder, `runtime.${extension}`);
    const dataFile = extension === 'relational' ? file + '.sqlite' : file;
    if (extension === 'relational') {
      const initial = new RelationalRepository(dataFile);
      const data = createSeedData();
      data.knowledgePoints = []; data.reviewStates = []; data.memoryEvents = [];
      await initial.save(data); initial.close();
    }
    const repository = await openRepository(dataFile);
    const before = await repository.read();
    repository.close?.();
    const server = await startServer(dataFile);
    try {
      assert.equal((await fetch(`${server.url}/api/health`)).status, 200);
      assert.equal((await fetch(`${server.url}/api/dashboard`)).status, 401);
      const login = await server.login();
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const response = await fetch(`${server.url}/api/dashboard`, { headers: { cookie } });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).system.pdfParser, 'offline_only');
      assert.equal((await fetch(`${server.url}/api/knowledge-v2/points`, { headers: { cookie } })).status, 200);
      assert.equal((await fetch(`${server.url}/api/pdf-imports`, { headers: { cookie } })).status, 410);
      checks.push({ database: extension, health: 200, anonymous: 401, login: 200, knowledge: 200, retiredPdf: 410 });
    } finally { await server.stop(); }
    const reopened = await openRepository(dataFile);
    try { assert.deepEqual((await reopened.read()).reviewLogs, before.reviewLogs); }
    finally { reopened.close?.(); }
  }
  console.log(JSON.stringify({ node: process.version, platform: process.platform, parserPackaged: false, checks }, null, 2));
} finally { await rm(folder, { recursive: true, force: true }); }
