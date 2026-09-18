import { ArkStudyAgent } from '../apps/api/src/ark/agent.js';
import { AGENT_PROMPT_VERSION } from '../apps/api/src/agent/prompts.js';
import { ArkFeedbackError, ArkFeedbackProvider } from '../apps/api/src/ark/feedback.js';

const provider = new ArkFeedbackProvider();
if (!provider.isConfigured()) {
  throw new Error('ARK_API_KEY 未配置。请先运行 npm run ark:configure。');
}

try {
  const profile = {
    name: '李羊羊',
    examGoal: '2027 年考研 333 教育综合',
    studyStage: 'first_round_completed',
    painPoints: ['容易遗忘', '难以坚持'],
    targetExamDate: '2026-12-20',
    dailyTaskLimit: 5
  };
  const agent = new ArkStudyAgent({ provider });
  const classifyStartedAt = performance.now();
  const decision = await agent.classify({ message: '你好，我今天有点焦虑，想先聊聊。', profile });
  const classifyMs = Math.round(performance.now() - classifyStartedAt);
  const chatStartedAt = performance.now();
  const conversation = await agent.chat({
    message: '我今天有点焦虑，帮我把第一步缩小一点。',
    profile,
    history: [],
    runtimeSummary: { dataMode: 'demo', completedToday: 0, todayTasks: [], weakPoints: [], activeSession: null }
  });
  const chatMs = Math.round(performance.now() - chatStartedAt);
  const feedbackStartedAt = performance.now();
  const feedback = await provider.reviewAnswer({
    task: { title: '连通性测试', prompt: '用一句话概括间隔复习的作用。' },
    answer: '通过在快要遗忘时复习，帮助长期记住内容。',
    profile
  });
  const feedbackMs = Math.round(performance.now() - feedbackStartedAt);
  console.log(JSON.stringify({
    status: 'ok',
    modelId: feedback.modelId,
    promptVersion: AGENT_PROMPT_VERSION,
    intent: decision.intent,
    latencyMs: { classify: classifyMs, chat: chatMs, feedback: feedbackMs },
    conversationCharacters: conversation.text.length,
    feedbackCharacters: feedback.feedback.length
  }));
} catch (error) {
  const code = error instanceof ArkFeedbackError ? error.code : 'unknown_error';
  console.error(JSON.stringify({ status: 'failed', code }));
  process.exitCode = 1;
}
