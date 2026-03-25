import { ConfigStore } from '../cli/ConfigStore.js';

type RuntimeConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

type TokenizerMode = 'count_tokens' | 'messages_usage';

type TokenizerMessageContent = Array<{ type: 'text'; text: string }> | string;

type ApiErrorPayload = {
  error?: {
    message?: string;
    type?: string;
  };
};

class ApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const CLAUDE_DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const TOKENIZER_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TOKEN_CACHE_SIZE = 300;

export class ClaudeTokenizer {
  private readonly configStore: ConfigStore;
  private readonly tokenCache = new Map<string, number>();
  private readonly modeCache = new Map<string, TokenizerMode>();
  private readonly messagesUsageBaselineCache = new Map<string, number>();

  constructor(configStore: ConfigStore) {
    this.configStore = configStore;
  }

  async countTextTokens(text: string): Promise<number> {
    const normalized = text.replace(/\r\n/g, '\n');
    if (!normalized.trim()) {
      return 0;
    }

    const runtime = await this.getRuntimeConfig();
    const cacheKey = `${runtime.baseUrl}|${runtime.model}|${normalized}`;
    const cached = this.tokenCache.get(cacheKey);
    if (typeof cached === 'number') {
      return cached;
    }

    const mode = await this.resolveMode(runtime);
    const tokenCount =
      mode === 'count_tokens'
        ? await this.countByCountTokensEndpoint(runtime, normalized)
        : await this.countByMessagesUsage(runtime, normalized);

    const safeValue = Math.max(0, tokenCount);
    if (this.tokenCache.size >= MAX_TOKEN_CACHE_SIZE) {
      const oldest = this.tokenCache.keys().next().value;
      if (oldest !== undefined) this.tokenCache.delete(oldest);
    }
    this.tokenCache.set(cacheKey, safeValue);
    return safeValue;
  }

  async getActiveMode(): Promise<TokenizerMode> {
    const runtime = await this.getRuntimeConfig();
    return this.resolveMode(runtime);
  }

  private async resolveMode(runtime: RuntimeConfig): Promise<TokenizerMode> {
    const runtimeKey = `${runtime.baseUrl}|${runtime.model}`;
    const cached = this.modeCache.get(runtimeKey);
    if (cached) {
      return cached;
    }

    try {
      await this.countByCountTokensEndpoint(runtime, 'tokenizer probe');
      this.modeCache.set(runtimeKey, 'count_tokens');
      return 'count_tokens';
    } catch (error) {
      if (this.shouldFallbackToMessagesUsage(error)) {
        this.modeCache.set(runtimeKey, 'messages_usage');
        return 'messages_usage';
      }
      throw error;
    }
  }

  private shouldFallbackToMessagesUsage(error: unknown): boolean {
    if (!(error instanceof ApiError)) {
      return false;
    }

    const normalizedBody = error.body.toLowerCase();
    if (error.status === 404 || error.status === 405 || error.status === 501) {
      return true;
    }

    if (normalizedBody.includes('invalid url') && normalizedBody.includes('count_tokens')) {
      return true;
    }

    if (normalizedBody.includes('unknown endpoint') && normalizedBody.includes('count_tokens')) {
      return true;
    }

    if (
      error.status === 400 &&
      (normalizedBody.includes('invalid argument') ||
        normalizedBody.includes('invalid request') ||
        normalizedBody.includes('invalid_request_error') ||
        normalizedBody.includes('unsupported') ||
        normalizedBody.includes('not supported') ||
        normalizedBody.includes('not implemented') ||
        normalizedBody.includes('extra inputs are not permitted'))
    ) {
      return true;
    }

    return false;
  }

  private async countByCountTokensEndpoint(runtime: RuntimeConfig, text: string): Promise<number> {
    const url = `${runtime.baseUrl}/messages/count_tokens`;
    const raw = await this.postJsonWithMessageContentVariants(url, runtime.apiKey, text, (content) => ({
      model: runtime.model,
      messages: [
        {
          role: 'user',
          content,
        },
      ],
    }));
    const parsed = this.parseJson<{ input_tokens?: number; total_tokens?: number }>(raw, 'count_tokens');
    const count = typeof parsed.input_tokens === 'number' ? parsed.input_tokens : parsed.total_tokens;

    if (typeof count !== 'number' || Number.isNaN(count) || count < 0) {
      throw new Error('Tokenizer response missing input token count.');
    }

    return count;
  }

  private async countByMessagesUsage(runtime: RuntimeConfig, text: string): Promise<number> {
    const runtimeKey = `${runtime.baseUrl}|${runtime.model}`;
    const baseline = await this.getMessagesUsageBaseline(runtime, runtimeKey);
    const raw = await this.countByMessagesUsageRaw(runtime, text);
    return Math.max(0, raw - baseline);
  }

  private async getMessagesUsageBaseline(runtime: RuntimeConfig, runtimeKey: string): Promise<number> {
    const cached = this.messagesUsageBaselineCache.get(runtimeKey);
    if (typeof cached === 'number') {
      return cached;
    }

    const baseline = await this.countByMessagesUsageRaw(runtime, '');
    this.messagesUsageBaselineCache.set(runtimeKey, baseline);
    return baseline;
  }

  private async countByMessagesUsageRaw(runtime: RuntimeConfig, text: string): Promise<number> {
    const url = `${runtime.baseUrl}/messages`;
    const raw = await this.postJsonWithMessageContentVariants(url, runtime.apiKey, text, (content) => ({
      model: runtime.model,
      max_tokens: 1,
      messages: [
        {
          role: 'user',
          content,
        },
      ],
    }));
    const parsed = this.parseJson<{ usage?: { input_tokens?: number } }>(raw, 'messages');
    const count = parsed.usage?.input_tokens;

    if (typeof count !== 'number' || Number.isNaN(count) || count < 0) {
      throw new Error('Tokenizer fallback response missing usage.input_tokens.');
    }

    return count;
  }

  private async postJsonWithMessageContentVariants(
    url: string,
    apiKey: string,
    text: string,
    buildPayload: (content: TokenizerMessageContent) => unknown
  ): Promise<string> {
    const variants = this.buildMessageContentVariants(text);
    let lastError: unknown;

    for (let index = 0; index < variants.length; index++) {
      try {
        return await this.postJson(url, apiKey, buildPayload(variants[index]));
      } catch (error) {
        lastError = error;
        if (!this.shouldRetryWithAlternateMessageContent(error, index, variants.length)) {
          throw error;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Tokenizer request failed unexpectedly.');
  }

  private async postJson(url: string, apiKey: string, payload: unknown): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), TOKENIZER_REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          signal: controller.signal,
          body: JSON.stringify(payload),
        });

        const raw = await response.text();
        if (!response.ok) {
          const detail = this.extractErrorMessage(raw);
          throw new ApiError(`Claude tokenizer request failed (${response.status}): ${detail}`, response.status, raw);
        }

        return raw;
      } catch (error) {
        if (this.isTimeoutError(error)) {
          throw new Error(`Claude tokenizer request timed out after ${this.formatTimeoutMs(TOKENIZER_REQUEST_TIMEOUT_MS)}.`);
        }
        if (error instanceof ApiError || !this.isRetryableNetworkError(error) || attempt === 1) {
          throw error;
        }
        await this.sleep(300 * (attempt + 1));
      } finally {
        clearTimeout(timeoutHandle);
      }
    }
    throw new Error('Tokenizer request failed unexpectedly.');
  }

  private buildMessageContentVariants(text: string): TokenizerMessageContent[] {
    return [[{ type: 'text', text }], text];
  }

  private shouldRetryWithAlternateMessageContent(
    error: unknown,
    attemptIndex: number,
    variantCount: number
  ): boolean {
    if (attemptIndex >= variantCount - 1 || !(error instanceof ApiError)) {
      return false;
    }

    return this.isMessageContentFormatError(error);
  }

  private isMessageContentFormatError(error: ApiError): boolean {
    if (error.status < 400 || error.status >= 500) {
      return false;
    }

    const normalizedBody = error.body.toLowerCase();
    return (
      normalizedBody.includes('invalid argument') ||
      normalizedBody.includes('invalid request') ||
      normalizedBody.includes('invalid_request_error') ||
      normalizedBody.includes('extra inputs are not permitted') ||
      normalizedBody.includes('unexpected') ||
      normalizedBody.includes('unsupported') ||
      normalizedBody.includes('not supported') ||
      normalizedBody.includes('messages') ||
      normalizedBody.includes('content') ||
      normalizedBody.includes('text')
    );
  }

  private parseJson<T>(raw: string, source: string): T {
    try {
      return (raw ? JSON.parse(raw) : {}) as T;
    } catch {
      throw new Error(`Tokenizer ${source} response is not valid JSON.`);
    }
  }

  private extractErrorMessage(raw: string): string {
    try {
      const parsed = JSON.parse(raw) as ApiErrorPayload;
      const nested = parsed?.error?.message?.trim();
      if (nested) {
        return nested;
      }
    } catch {
      // Ignore JSON parse error and use raw fallback.
    }
    return raw.slice(0, 300);
  }

  private isRetryableNetworkError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    const normalized = error.message.toLowerCase();
    return normalized.includes('fetch failed') || normalized.includes('network');
  }

  private isTimeoutError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    return error.name === 'AbortError' || error.message.toLowerCase().includes('aborted');
  }

  private formatTimeoutMs(timeoutMs: number): string {
    const totalSeconds = Math.max(1, Math.round(timeoutMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (seconds === 0) {
      return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    }
    return `${minutes}m ${seconds}s`;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private async getRuntimeConfig(): Promise<RuntimeConfig> {
    const config = await this.configStore.getConfig();
    const providerConfig = config.providers.claude ?? {};
    const apiKey = providerConfig.apiKey?.trim();
    const model = providerConfig.model?.trim();

    if (!apiKey) {
      throw new Error('Claude API key is missing. Set AERIS_CLAUDE_API_KEY in .env before scanning tokens.');
    }

    if (!model) {
      throw new Error('Claude model is missing. Set AERIS_CLAUDE_MODEL in .env or use /model <model-name> before scanning tokens.');
    }

    return {
      apiKey,
      baseUrl: (providerConfig.baseUrl?.trim() || CLAUDE_DEFAULT_BASE_URL).replace(/\/+$/, ''),
      model,
    };
  }
}
