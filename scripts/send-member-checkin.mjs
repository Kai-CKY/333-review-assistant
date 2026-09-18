import * as lark from '@larksuiteoapi/node-sdk';
import { createHash } from 'node:crypto';
const [chatId, openId] = process.argv.slice(2);
if (!/^oc_[A-Za-z0-9]+$/.test(chatId ?? '') || !/^ou_[A-Za-z0-9]+$/.test(openId ?? '')) throw new Error('Exact chat and member IDs are required');
const client = new lark.Client({ appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET, logger: { debug() {}, info() {}, warn() {}, error() {}, trace() {} } });
const members = await client.im.v1.chatMembers.get({ path: { chat_id: chatId }, params: { member_id_type: 'open_id', page_size: 100 } });
if (members.code !== 0 || !members.data?.items?.some((m) => m.member_id === openId)) throw new Error('Target member not found');
const response = await client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: {
  receive_id: chatId, msg_type: 'text',
  content: JSON.stringify({ text: `<at user_id="${openId}"></at> 今天的任务完成情况怎么样？已经完成了哪些，还有哪些没完成或卡住了？` }),
  uuid: createHash('sha256').update(`member-checkin:2026-09-16:${chatId}:${openId}`).digest('hex').slice(0, 40)
} });
console.log(JSON.stringify({ code: response.code, messageId: response.data?.message_id, mentions: response.data?.mentions?.map((m) => ({ id: m.id, name: m.name })) }));
if (response.code !== 0) process.exitCode = 1;
