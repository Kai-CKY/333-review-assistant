import * as lark from '@larksuiteoapi/node-sdk';
import { readFile, writeFile } from 'node:fs/promises';
import { ArkFeedbackProvider } from '../apps/api/src/ark/feedback.js';
const chatId = process.argv[2];
if (!/^oc_[A-Za-z0-9]+$/.test(chatId ?? '')) throw new Error('Exact test group required');
const client = new lark.Client({ appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET, logger: { debug() {}, info() {}, warn() {}, error() {}, trace() {} } });
let stage = 'upload';
try {
  const image = await readFile(new URL('../.data/vision-test.png', import.meta.url));
  const upload = await client.im.v1.image.create({ data: { image_type: 'message', image } });
  if (!upload?.image_key) throw new Error('No image key');
  stage = 'send';
  const sent = await client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, msg_type: 'image', content: JSON.stringify({ image_key: upload.image_key }), uuid: 'vision-fixture-20260916-Q7M4' } });
  if (sent.code !== 0 || !sent.data?.message_id) throw new Error('Send failed');
  stage = 'download_message_resource';
  const resource = await client.im.v1.messageResource.get({ path: { message_id: sent.data.message_id, file_key: upload.image_key }, params: { type: 'image' } });
  const parts = [];
  for await (const part of resource.getReadableStream()) parts.push(Buffer.from(part));
  const bytes = Buffer.concat(parts);
  stage = 'vision';
  const result = await new ArkFeedbackProvider().complete({ temperature: 0, maxTokens: 600, messages: [{ role: 'user', content: [
    { type: 'text', text: '请识别图中文字和校验码，描述图形的颜色、形状和左右位置。不要猜测。' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${bytes.toString('base64')}` } }
  ] }] });
  const report = { stage: 'completed', messageId: sent.data.message_id, bytes: bytes.length, ...result, passed: ['Q7M4', '20', '3', '45', '蓝', '红'].every((x) => result.content.includes(x)) };
  await writeFile(new URL('../.data/feishu-vision-test-result.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  console.log(JSON.stringify({ stage, code: error.response?.data?.code ?? error.code ?? 'test_failed', requiredPermissions: error.response?.data?.error?.permission_violations }));
  process.exitCode = 1;
}
