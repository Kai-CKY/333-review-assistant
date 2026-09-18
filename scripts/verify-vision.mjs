import { readFile, writeFile } from 'node:fs/promises';
import { ArkFeedbackProvider } from '../apps/api/src/ark/feedback.js';
const provider = new ArkFeedbackProvider();
const bytes = await readFile(new URL('../.data/vision-test.png', import.meta.url));
try {
  const result = await provider.complete({ maxTokens: 600, temperature: 0, messages: [{ role: 'user', content: [
    { type: 'text', text: '请逐字识别图片中的学习记录和校验码，并描述下方图形的颜色、形状和左右位置。只根据图片回答。' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${bytes.toString('base64')}` } }
  ] }] });
  const report = { ...result, passed: ['Q7M4', '20', '3', '45', '蓝', '红'].every((value) => result.content.includes(value)) };
  await writeFile(new URL('../.data/vision-test-result.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  console.log(JSON.stringify({ modelId: provider.modelId, error: error.code }));
  process.exitCode = 1;
}
