import * as lark from '@larksuiteoapi/node-sdk';
import { fileURLToPath } from 'node:url';
import { readGroupHistory, saveHistoryProgress } from '../apps/api/src/feishu/history-progress.js';
import { LocalRepository } from '../apps/api/src/repository.js';
import { StudyService } from '../apps/api/src/study-service.js';
const [chatId, senderId, ...messageIds] = process.argv.slice(2);
if (!/^oc_[A-Za-z0-9]+$/.test(chatId ?? '')) throw new Error('Exact group ID required');
const client = new lark.Client({ appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET, logger: { debug() {}, info() {}, warn() {}, error() {}, trace() {} } });
try {
  const messages = await readGroupHistory(client, chatId);
  if (!senderId) {
    console.log(JSON.stringify(messages.map((m) => ({ id: m.message_id, sender: m.sender, type: m.msg_type, at: m.create_time, body: m.body, deleted: m.deleted })), null, 2));
  } else {
    const repository = new LocalRepository(process.env.DATA_FILE || fileURLToPath(new URL('../.data/review-assistant.json', import.meta.url)));
    console.log(JSON.stringify(await saveHistoryProgress({ studyService: new StudyService(repository), client, chatId, senderId, messages, messageIds }), null, 2));
  }
} catch (error) {
  console.log(JSON.stringify({ code: error.response?.data?.code ?? error.code ?? error.message }));
  process.exitCode = 1;
}
