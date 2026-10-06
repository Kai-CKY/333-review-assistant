// Synthetic fixtures only. These identifiers and amounts are not production evidence.
export const sampleDate = '2026-10-06';
export const sampleRates = { input: 6, cached: 1.2, output: 30, version: '演示价目 · 2026-10-06' };
export const categories = {
  photo: { label: '图片整理', color: '#397b9e', short: '图' },
  feedback: { label: '答题反馈', color: '#cb8260', short: '答' },
  chat: { label: '日常对话', color: '#759b87', short: '聊' },
  engineering: { label: '工程验证', color: '#9296b4', short: '验' }
};
export const environments = { prod: '正式环境', test: '测试环境', dev: '本地验证', all: '全部环境' };
const keys = { prod: '333-prod', test: '333-staging', dev: '333-local' };
const tasks = [];
let sequence = 0;
function request(task, step, input, output, options = {}) {
  const number = ++sequence;
  const unknown = options.unknown === true;
  const cached = unknown ? null : Math.round(input * (options.cacheRatio ?? 0.15));
  return {
    id: `req-demo-${String(number).padStart(4, '0')}`, taskId: task.id,
    title: task.title, category: task.category, env: task.env, key: keys[task.env],
    at: `${task.date}T${task.hour}:${String((number * 3) % 60).padStart(2, '0')}:00+08:00`,
    date: task.date, step, input: unknown ? null : input, output: unknown ? null : output,
    cached, reasoning: unknown ? null : Math.round(output * (options.reasoningRatio ?? 0.55)),
    status: options.status ?? 'success', usageStatus: unknown ? 'unknown' : 'known',
    retry: options.retry ?? 0, toolCalls: options.toolCalls ?? 0,
    toolCostUnknown: Boolean(options.toolCalls), error: options.error ?? null,
    model: 'doubao-seed-2-1-pro-260915',
    api: options.toolCalls ? 'Responses' : 'Chat',
    responseId: unknown ? null : `response-demo-${String(number).padStart(4, '0')}`,
    // Nanoyuan keep aggregation exact before rounding for presentation.
    nanoCost: unknown ? null : (input - cached) * 6000 + cached * 1200 + output * 30000
  };
}
function makeTask(date, title, category, env, hour, steps) {
  const task = { id: `task-demo-${String(tasks.length + 1).padStart(3, '0')}`, date, title, category, env, hour, requests: [] };
  task.requests = steps.map(args => request(task, ...args));
  tasks.push(task);
}
for (let day = 1; day <= 6; day++) {
  const date = `2026-10-${String(day).padStart(2, '0')}`;
  const factor = 0.72 + day * 0.11;
  const tokens = value => Math.round(value * factor);
  makeTask(date, day === 6 ? '教育学笔记 · 3 张原图' : `教育学笔记 · ${day % 2 + 1} 张原图`, 'photo', 'prod', '18', [
    ['OCR · 第一次识读', tokens(31000), tokens(22000), { reasoningRatio: 0.72 }],
    ['OCR · 第二次识读', tokens(31000), tokens(21000), { reasoningRatio: 0.72 }],
    ['合并与差异整理', tokens(52000), tokens(17000), { reasoningRatio: 0.72 }],
    ['联网核验 · 第 1 批', tokens(20000), Math.min(11000, tokens(9500)), { toolCalls: 3 }],
    ['联网核验 · 第 2 批', tokens(24000), 10500, { toolCalls: 2, ...(day === 6 ? { status: 'parse_failed', error: '业务结果格式无效' } : {}) }],
    ...(day === 6 ? [['联网核验 · 第 2 批重试', tokens(24000), 9800, { toolCalls: 2, retry: 1 }], ['联网核验 · 第 3 批', 0, 0, { unknown: true, status: 'timeout', error: '连接超时，未取得最终用量' }]] : [])
  ]);
  makeTask(date, '教育心理学 · 回忆反馈', 'feedback', 'prod', '20', [
    ['反馈 · 要点一', tokens(6500), tokens(4200)],
    ['反馈 · 要点二', tokens(6500), tokens(3600)],
    ['反馈 · 要点三', tokens(7200), tokens(3900)]
  ]);
  makeTask(date, '群内学习交流', 'chat', 'prod', '21', [
    ['群聊回复', tokens(9400), tokens(2900)],
    ['群聊回复', tokens(8400), tokens(2400), { cacheRatio: 0.4 }]
  ]);
  if (day >= 4) makeTask(date, '图片流程回归验证', 'engineering', 'test', '16', [
    ['OCR · 隔离验证', tokens(14000), tokens(8500)],
    ['核验 · 隔离验证', tokens(10000), 6500, { toolCalls: 1 }]
  ]);
}
makeTask(sampleDate, '本人答案 · 反馈待核实', 'feedback', 'prod', '21', [
  ['答题反馈', 0, 0, { unknown: true, status: 'interrupted', error: '流式连接中断，未取得最终用量' }]
]);
makeTask(sampleDate, '本地 OCR · 手动流程验证', 'engineering', 'dev', '14', [
  ['OCR · 独立样例图片', 4800, 2800, { reasoningRatio: 0.2 }]
]);
export const sampleTasks = tasks;
export const sampleRequests = tasks.flatMap(task => task.requests);
