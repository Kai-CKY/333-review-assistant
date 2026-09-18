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
source = setValue(source, 'FEISHU_ENABLED', 'true');
if (!readValue(source, 'PORT')) source = setValue(source, 'PORT', '3334');
const temporaryPath = `${envPath}.${process.pid}.tmp`;
await writeFile(temporaryPath, source, { encoding: 'utf8', mode: 0o600 });
await rename(temporaryPath, envPath);
console.log('飞书首测已启用：后续 npm run dev:feishu 会只响应绑定账号的私聊。');
