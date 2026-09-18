import { readFile, writeFile, rename } from 'node:fs/promises';
const file = new URL('../.env.local', import.meta.url);
const chatId = process.argv[2];
if (!/^oc_[A-Za-z0-9]+$/.test(chatId ?? '')) throw new Error('A valid group chat ID is required');
let content = await readFile(file, 'utf8');
for (const [key, value] of Object.entries({ FEISHU_ENABLED: 'true', FEISHU_GROUP_CHAT_ENABLED: 'true', FEISHU_TEST_GROUP_ID: chatId })) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  content = pattern.test(content) ? content.replace(pattern, `${key}=${value}`) : `${content.trimEnd()}\n${key}=${value}\n`;
}
const temp = new URL(`../.env.local.${process.pid}.tmp`, import.meta.url);
await writeFile(temp, content, { mode: 0o600 });
await rename(temp, file);
console.log('Group conversation enabled for:', chatId);
