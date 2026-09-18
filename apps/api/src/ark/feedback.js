import { answerFeedbackSystemPrompt } from '../agent/prompts.js';

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_MODEL_ID = 'doubao-seed-2-1-turbo-260628';
const DEFAULT_THINKING_TYPE = 'disabled';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ANSWER_CHARS = 8_000;
const MAX_FEEDBACK_PART_CHARS = 140;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clip(value, maximum) {
  const normalized = text(value);
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum)}…`;
}

function endpoint(baseUrl) {
  return `${text(baseUrl).replace(/\/+$/, '')}/chat/completions`;
}

function timeoutValue(value, fallback = REQUEST_TIMEOUT_MS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(60_000, Math.max(1_000, Math.round(parsed)));
}

function thinkingType(value) {
  return value === 'enabled' ? 'enabled' : DEFAULT_THINKING_TYPE;
}

function serviceTier(value) {
  return value === 'fast' ? 'fast' : null;
}

function userPrompt({ task, answer }) {
  return [
    `知识点：${clip(task?.title, 300) || '未命名知识点'}`,
    `回忆题：${clip(task?.prompt, 1_500) || '未提供'}`,
    `用户回忆：${clip(answer, MAX_ANSWER_CHARS)}`
  ].join('\n\n');
}

function responseText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => typeof part === 'string' ? part : part?.text)
      .filter((part) => typeof part === 'string')
      .join('');
  }
  return '';
}

function normalizeFeedback(content) {
  const cleaned = text(content)
    .replace(/\*\*/g, '')
    .replace(/^[\s>*-]+/gm, '')
    .replace(/\r/g, '');
  const match = cleaned.match(
    /^亮点[：:]\s*([\s\S]*?)\s*(?:\n+|[；;])\s*可补充[：:]\s*([\s\S]*?)\s*(?:\n+|[；;])\s*下一步[：:]\s*([\s\S]*?)\s*$/
  );
  if (!match || match.slice(1).some((part) => !part.trim())) throw new ArkFeedbackError('invalid_feedback');
  const [strength, addition, nextStep] = match.slice(1).map((part) => clip(part.replace(/\s+/g, ' '), MAX_FEEDBACK_PART_CHARS));
  return `亮点：${strength}\n可补充：${addition}\n下一步：${nextStep}`;
}

export class ArkFeedbackError extends Error {
  constructor(code) {
    super(`Ark feedback request failed: ${code}`);
    this.name = 'ArkFeedbackError';
    this.code = code;
  }
}

/**
 * Minimal server-side client for Ark's OpenAI-compatible chat endpoint.
 * It deliberately never returns provider error bodies, which can otherwise
 * contain request metadata, and it never changes review scheduling.
 */
export class ArkFeedbackProvider {
  constructor({
    apiKey = process.env.ARK_API_KEY,
    baseUrl = process.env.ARK_BASE_URL || DEFAULT_BASE_URL,
    modelId = process.env.ARK_MODEL_ID || DEFAULT_MODEL_ID,
    thinking = process.env.ARK_THINKING_TYPE || DEFAULT_THINKING_TYPE,
    tier = process.env.ARK_SERVICE_TIER,
    fetchImpl = globalThis.fetch,
    timeoutMs = process.env.ARK_TIMEOUT_MS ?? REQUEST_TIMEOUT_MS
  } = {}) {
    this.apiKey = text(apiKey);
    this.baseUrl = text(baseUrl) || DEFAULT_BASE_URL;
    this.modelId = text(modelId) || DEFAULT_MODEL_ID;
    this.thinking = thinkingType(thinking);
    this.serviceTier = serviceTier(tier);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutValue(timeoutMs);
  }

  isConfigured() {
    return Boolean(this.apiKey && this.modelId && typeof this.fetchImpl === 'function');
  }

  async complete({ messages, temperature = 0.2, maxTokens = 320 }) {
    if (!this.isConfigured()) throw new ArkFeedbackError('not_configured');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(endpoint(this.baseUrl), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: this.modelId,
          temperature,
          max_tokens: maxTokens,
          thinking: { type: this.thinking },
          ...(this.serviceTier ? { service_tier: this.serviceTier } : {}),
          messages
        }),
        signal: controller.signal
      });
      if (!response.ok) throw new ArkFeedbackError(`upstream_${response.status}`);
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new ArkFeedbackError('invalid_response');
      }
      const content = responseText(payload).trim();
      if (!content) throw new ArkFeedbackError('empty_response');
      return { content, modelId: this.modelId, finishReason: payload.choices?.[0]?.finish_reason, usage: payload.usage };
    } catch (error) {
      if (error instanceof ArkFeedbackError) throw error;
      if (error?.name === 'AbortError') throw new ArkFeedbackError('timeout');
      throw new ArkFeedbackError('network_error');
    } finally {
      clearTimeout(timeout);
    }
  }

  async reviewAnswer({ task, answer, profile = {} }) {
    if (!text(answer)) throw new ArkFeedbackError('invalid_answer');
    const result = await this.complete({
      messages: [
        { role: 'system', content: answerFeedbackSystemPrompt(profile) },
        { role: 'user', content: userPrompt({ task, answer }) }
      ]
    });
    return { feedback: normalizeFeedback(result.content), modelId: result.modelId };
  }
}

export const arkDefaults = Object.freeze({
  baseUrl: DEFAULT_BASE_URL,
  modelId: DEFAULT_MODEL_ID,
  thinkingType: DEFAULT_THINKING_TYPE
});
