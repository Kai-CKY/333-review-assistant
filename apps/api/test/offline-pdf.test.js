import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { LocalRepository } from '../src/repository.js';
import { createGroupConversation } from '../src/feishu/group-conversation.js';
import { startServer } from './helpers/http-server.js';

test('online PDF routes retire without contacting a stale parser or changing existing jobs', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), '333-offline-pdf-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const repository = new LocalRepository(path.join(folder, 'data.json'));
  const historicalJob = { id: 'KP-11111111', status: 'queued', filename: 'retained.pdf' };
  await repository.mutate(data => { data.pdfImports = { [historicalJob.id]: historicalJob }; });
  let parserCalls = 0;
  const parser = createServer((_request, response) => { parserCalls++; response.end('{}'); });
  parser.listen(0, '127.0.0.1'); await once(parser, 'listening');
  t.after(() => new Promise(resolve => parser.close(resolve)));
  const server = await startServer(repository.filePath, { PDF_PARSER_URL: `http://127.0.0.1:${parser.address().port}` });
  t.after(() => server.stop());
  assert.equal((await fetch(`${server.url}/api/pdf-imports`)).status, 401);
  const cookie = (await server.login()).headers.get('set-cookie').split(';')[0];
  for (const endpoint of ['/api/pdf-imports', '/api/pdf-imports/KP-11111111/confirm']) {
    const response = await fetch(`${server.url}${endpoint}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 410); assert.match((await response.json()).error, /离线解析/);
  }
  assert.equal((await fetch(`${server.url}/api/pdf-imports`, { headers: { cookie } })).status, 410);
  const dashboard = await (await fetch(`${server.url}/api/dashboard`, { headers: { cookie } })).json();
  assert.equal(dashboard.system.pdfParser, 'offline_only');
  const html = await (await fetch(server.url, { headers: { cookie } })).text();
  assert.doesNotMatch(html, /pdf-upload|pdf-import\.js|上传并解析/);
  assert.match(html, /knowledge-workspace\.js/);
  assert.equal((await fetch(`${server.url}/pdf-import.js`, { headers: { cookie } })).status, 404);
  assert.equal(parserCalls, 0);
  assert.deepEqual((await repository.read()).pdfImports[historicalJob.id], historicalJob);
});

test('group PDF files and legacy commands give offline guidance without downloading or using a model', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), '333-offline-group-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const repository = new LocalRepository(path.join(folder, 'data.json'));
  const messages = [];
  const group = createGroupConversation({ repository, chatId: 'group', appId: 'offline', yangyangOpenId: 'learner', ownerOpenId: 'owner', logger: { warn() {} },
    provider: { isConfigured: () => true, complete: async () => { throw new Error('must_not_call_model'); } },
    channel: { send: async (_id, value) => messages.push(value.text), rawClient: { im: { v1: { messageResource: { get: async () => { throw new Error('must_not_download_file'); } } } } } }
  });
  for (const senderId of ['learner', 'owner']) {
    await group({ chatId: 'group', senderId, messageId: `file-${senderId}`, rawContentType: 'file', content: '', resources: [{ type: 'file', fileName: 'textbook.pdf' }] });
    assert.match(messages.at(-1), /本地解析/);
    await group({ chatId: 'group', senderId, messageId: `confirm-${senderId}`, rawContentType: 'text', content: '确认PDF KP-11111111' });
    assert.match(messages.at(-1), /已入库教材/);
  }
  assert.equal((await repository.read()).pdfImports, undefined);
});

test('deployment packages only the learning application, with no parser service or model volume', async () => {
  const compose = await readFile(new URL('../../../compose.yaml', import.meta.url), 'utf8');
  assert.doesNotMatch(compose, /pdf-parser|mineru-models|PDF_PARSER_URL/);
  const dockerfile = await readFile(new URL('../../../Dockerfile', import.meta.url), 'utf8');
  assert.doesNotMatch(dockerfile, /COPY apps \.\/apps/);
});
