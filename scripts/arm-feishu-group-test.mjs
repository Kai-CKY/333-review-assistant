import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env.local');

function readValue(source, name) {
  return source.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1].trim() ?? '';
}

function setValue(source, name, value) {
  const line = `${name}=${value}`;
  const matcher = new RegExp(`^${name}=.*$`, 'm');
  return matcher.test(source) ? source.replace(matcher, line) : `${source.trimEnd()}\n${line}\n`;
}

function validChatId(value) {
  return /^oc_[A-Za-z0-9]+$/.test(value);
}

function validOpenId(value) {
  return /^ou_[A-Za-z0-9]+$/.test(value);
}

const [chatId, targetReference, ...extraArguments] = process.argv.slice(2);
if (extraArguments.length || !validChatId(chatId ?? '') || !targetReference) {
  throw new Error('用法：npm run feishu:group-test -- oc_<群聊 ID> ou_<羊羊的 open_id>|@tester');
}

let source;
try {
  source = await readFile(envPath, 'utf8');
} catch (error) {
  if (error.code === 'ENOENT') throw new Error('找不到 .env.local；请先创建飞书应用。');
  throw error;
}

if (!readValue(source, 'FEISHU_APP_ID') || !readValue(source, 'FEISHU_APP_SECRET') || !readValue(source, 'FEISHU_TESTER_OPEN_ID')) {
  throw new Error('飞书首测凭据不完整；请先重新运行 npm run feishu:create。');
}

const targetOpenId = targetReference === '@tester'
  ? readValue(source, 'FEISHU_TESTER_OPEN_ID')
  : targetReference;
if (!validOpenId(targetOpenId)) {
  throw new Error('羊羊的目标账号必须是准确的 ou_ open_id；只有在已确认羊羊就是当前绑定测试账号时才可使用 @tester。');
}

source = setValue(source, 'FEISHU_ENABLED', 'true');
source = setValue(source, 'FEISHU_GROUP_TEST_ENABLED', 'true');
source = setValue(source, 'FEISHU_TEST_GROUP_ID', chatId);
source = setValue(source, 'FEISHU_GROUP_TARGET_OPEN_ID', targetOpenId);

const temporaryPath = `${envPath}.${process.pid}.tmp`;
await writeFile(temporaryPath, source, { encoding: 'utf8', mode: 0o600 });
await rename(temporaryPath, envPath);

console.log(`限定群测已启用：${chatId}`);
console.log('已写入精确的目标 open_id；不会按昵称或当前测试账号猜测羊羊身份。');
console.log('运行 npm run dev:feishu 后，目标账号加入指定群时机器人只会发送一次今日学习情况提问。');
