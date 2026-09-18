import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { arkDefaults } from '../apps/api/src/ark/feedback.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env.local');

function setEnvValue(source, name, value) {
  const line = `${name}=${value}`;
  const matcher = new RegExp(`^${name}=.*$`, 'm');
  return matcher.test(source)
    ? source.replace(matcher, line)
    : `${source.trimEnd()}\n${line}\n`;
}

async function readSecretFromTerminal() {
  const rawMode = Boolean(process.stdin.isTTY && process.stdin.setRawMode);
  if (rawMode) process.stdin.setRawMode(true);
  process.stdout.write('粘贴新的 Ark API Key 后按 Enter（输入不会回显）： ');
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk.toString('utf8');
      if (input.includes('\u0003')) throw new Error('已取消配置');
      if (input.includes('\r') || input.includes('\n')) break;
    }
    return input.split(/\r?\n|\r/)[0].trim();
  } finally {
    if (rawMode) process.stdin.setRawMode(false);
    process.stdout.write('\n');
  }
}

const apiKey = await readSecretFromTerminal();
if (!apiKey.startsWith('ark-') || apiKey.length < 16) {
  throw new Error('未收到有效的 Ark API Key；没有写入任何配置。');
}

let source = '';
try {
  source = await readFile(envPath, 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
source = setEnvValue(source, 'ARK_API_KEY', apiKey);
source = setEnvValue(source, 'ARK_BASE_URL', arkDefaults.baseUrl);
source = setEnvValue(source, 'ARK_MODEL_ID', arkDefaults.modelId);
source = setEnvValue(source, 'ARK_TIMEOUT_MS', '45000');
const temporaryPath = `${envPath}.${process.pid}.tmp`;
await writeFile(temporaryPath, source, { encoding: 'utf8', mode: 0o600 });
await rename(temporaryPath, envPath);
console.log('Ark 配置已安全写入本机 .env.local：Seed 2.1 Turbo 已选中，密钥未显示。');
