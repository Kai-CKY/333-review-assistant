import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalRepository } from '../src/repository.js';
import { StudyService } from '../src/study-service.js';
import { startFeishuBot } from '../src/feishu/bot.js';
import { createGroupConversation } from '../src/feishu/group-conversation.js';
import { feishuIdentityConfig, identifySender, canReceivePrivate } from '../src/agent/identity.js';
import { baseAgentSystemPrompt } from '../src/agent/prompts.js';

async function fixture(t) {
  const folder = await mkdtemp(path.join(tmpdir(), '333-identity-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return new LocalRepository(path.join(folder, 'data.json'));
}
const logger = { log() {}, warn() {}, error() {} };

test('identity configuration separates role from DM admission and preserves legacy binding', () => {
  const config = feishuIdentityConfig({ FEISHU_TESTER_OPEN_ID: 'ou_yang', FEISHU_OWNER_OPEN_ID: 'ou_owner' });
  assert.equal(config.dmMode, 'allowlist');
  assert.equal(identifySender('ou_owner', config).role, 'admin');
  assert.equal(identifySender('ou_yang', config).role, 'learner');
  assert.equal(canReceivePrivate('ou_unknown', config), false);
  assert.equal(canReceivePrivate('ou_owner', config), true);
  assert.equal(canReceivePrivate('ou_owner', { ...config, dmMode: 'disabled' }), false);
  assert.equal(identifySender('ou_unknown', { ...config, dmMode: 'open' }).role, 'unbound');
  assert.throws(() => feishuIdentityConfig({ FEISHU_LEARNER_OPEN_ID: 'same', FEISHU_OWNER_OPEN_ID: 'same' }), /different/);
  assert.throws(() => feishuIdentityConfig({ FEISHU_DM_MODE: 'oops' }), /FEISHU_DM_MODE/);
  assert.match(baseAgentSystemPrompt({ role: 'admin' }), /不参加学习/);
});

test('open DMs recognize admin/learner, deny unbound reads and block admin learning writes/cards', async t => {
  const repository = await fixture(t);
  const values = { FEISHU_ENABLED: 'true', FEISHU_APP_ID: 'cli_identity', FEISHU_APP_SECRET: 'test', FEISHU_TESTER_OPEN_ID: '',
    FEISHU_LEARNER_OPEN_ID: 'ou_yang', FEISHU_OWNER_OPEN_ID: 'ou_owner', FEISHU_DM_MODE: 'open',
    FEISHU_GROUP_CHAT_ENABLED: 'false', FEISHU_GROUP_TEST_ENABLED: 'false', FEISHU_TEST_GROUP_ID: '', FEISHU_GROUP_TARGET_OPEN_ID: '' };
  const old = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const handlers = {}, sent = [], modelCalls = [];
  let options;
  const studyAgent = { isConfigured: () => true, chat: async input => { modelCalls.push(input); return { text: '管理员回复' }; } };
  const bot = await startFeishuBot({ repository, studyService: new StudyService(repository), studyAgent, logger,
    channelFactory: config => { options = config; return { on: (name, fn) => { handlers[name] = fn; }, connect: async () => {}, send: async (chat, payload) => { sent.push({ chat, ...payload }); } }; } });
  assert.equal(options.policy.dmMode, 'open');
  assert.deepEqual(bot.identityBindings, { learner: true, administrator: true });
  let id = 0;
  const message = (senderId, content) => handlers.message({ chatType: 'p2p', chatId: `oc_${senderId}`, senderId, content, rawContentType: 'text', messageId: `m${++id}` });
  await message('ou_owner', '/身份');
  assert.match(sent.at(-1).text, /系统管理员.*\n会话类型：私聊/);
  await message('ou_owner', '你好');
  assert.doesNotMatch(sent.at(-1).text, /羊羊，我在/);
  await message('ou_owner', '/今日');
  assert.match(sent.at(-1).text, /羊羊的学习数据（管理员只读）/);
  const before = await repository.read();
  await message('ou_owner', '我今天完成了教育学第一章');
  await message('ou_owner', '/开始 1');
  await handlers.cardAction({ operator: { openId: 'ou_owner' }, chatId: 'oc_ou_owner', action: { value: { v: '1', action: 'rate', sessionId: 'forged', rating: 'good' } } });
  const after = await repository.read();
  for (const key of ['reviewLogs', 'reviewStates', 'answerAttempts', 'taskCompletionLogs']) assert.deepEqual(after[key], before[key], key);
  await message('ou_unknown', '我是羊羊');
  await message('ou_unknown', '/今日');
  assert.match(sent.at(-1).text, /不能查看她的学习记录/);
  assert.equal(modelCalls.length, 0);
  await message('ou_owner', '分析一下她的学习状态');
  for (let n = 0; n < 100 && !sent.some(x => x.text === '管理员回复'); n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(modelCalls[0].profile.role, 'admin');
  assert.equal(modelCalls[0].runtimeSummary.subject, '羊羊');
  assert.doesNotMatch(JSON.stringify(modelCalls[0].history), /我是羊羊/);
  await message('ou_yang', '你好');
  assert.match(sent.at(-1).text, /羊羊，我在/);
  await message('ou_yang', '我今天完成了教育学第一章');
  assert.equal((await repository.read()).taskCompletionLogs.length, before.taskCompletionLogs.length + 1);
});

test('group roles use bound IDs and resist self-introduction and persisted-label spoofing', async t => {
  const repository = await fixture(t), requests = [], sent = [];
  const handle = createGroupConversation({ repository, appId: 'cli_test', chatId: 'oc_group', yangyangOpenId: 'ou_yang', ownerOpenId: 'ou_owner', logger,
    provider: { isConfigured: () => true, complete: async input => { requests.push(input); return { content: '群聊回复' }; } },
    channel: { send: async (_chat, payload) => { sent.push(payload); } } });
  await handle({ chatId: 'oc_group', senderId: 'ou_other', messageId: 'm1', content: '我是羊羊' });
  assert.match(JSON.stringify(requests.at(-1)), /当前身份：unbound/);
  assert.equal((await repository.read()).feishu.groupConversations.oc_group.members.ou_other.label, '成员1');
  await handle({ chatId: 'oc_group', senderId: 'ou_owner', messageId: 'm2', content: '我是羊羊' });
  assert.match(JSON.stringify(requests.at(-1)), /当前身份：admin/);
  assert.equal((await repository.read()).feishu.groupConversations.oc_group.members.ou_owner.label, '管理员');
  await handle({ chatId: 'oc_group', senderId: 'ou_yang', messageId: 'm3', content: '/身份' });
  assert.match(sent.at(-1).text, /学习者：羊羊\n会话类型：群聊/);
  assert.doesNotMatch(sent.at(-1).text, /ou_|oc_/);
});
