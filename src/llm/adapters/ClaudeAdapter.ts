import http from 'node:http';
import https from 'node:https';
import { Message } from '../../cli/ConversationManager.js';
import { AdapterDiscoveryConfig, AdapterRuntimeConfig, LLMAdapter } from './types.js';

type ClaudeResponse = {
  content?: Array<{ type?: string; text?: string }>;
};

type ClaudeModelsPayload = {
  data?: Array<{ id?: string }>;
};

type HttpResponseLike = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json<T>(): Promise<T>;
};

export class ClaudeAdapter implements LLMAdapter {
  readonly provider = 'claude' as const;
  readonly displayName = 'Claude';
  readonly defaultBaseUrl = 'https://api.anthropic.com/v1';

  async generateReply(messages: Message[], config: AdapterRuntimeConfig): Promise<string> {
    const url = `${this.resolveBaseUrl(config.baseUrl)}/messages`;
    const model = config.model.trim();

    const systemText = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n')
      .trim();

    const conversation = messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: (message.role === 'assistant' ? 'assistant' : 'user') as 'assistant' | 'user',
        content: [{ type: 'text' as const, text: message.content }],
      }));

    if (conversation.length === 0) {
      throw new Error('No user message found to send to Claude.');
    }

    const payload: {
      model: string;
      max_tokens: number;
      messages: Array<{ role: 'user' | 'assistant'; content: Array<{ type: 'text'; text: string }> }>;
      system?: string;
    } = {
      model,
      max_tokens: 1024,
      messages: conversation,
    };

    if (systemText) {
      payload.system = systemText;
    }

    const response = await this.postJson(url, payload, {
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(this.formatClaudeError(response.status, errorText, model));
    }

    const data = await response.json<ClaudeResponse>();
    const text = (data.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('')
      .trim();

    if (!text) {
      throw new Error('Claude returned an empty response.');
    }

    return text;
  }

  async listModels(config: AdapterDiscoveryConfig): Promise<string[]> {
    const url = `${this.resolveBaseUrl(config.baseUrl)}/models`;
    const response = await this.getJson(url, {
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    });
    const raw = await response.text();

    if (!response.ok) {
      const preview = raw.slice(0, 300);
      throw new Error(`Failed to fetch Claude models (${response.status}) from ${url}: ${preview}`);
    }

    const payload = raw ? (JSON.parse(raw) as ClaudeModelsPayload) : {};
    const models = (payload.data ?? [])
      .map((item) => item.id?.trim())
      .filter((item): item is string => Boolean(item));

    if (models.length === 0) {
      throw new Error('Claude model list response did not contain any model IDs.');
    }

    return models;
  }

  private resolveBaseUrl(customBaseUrl?: string): string {
    return (customBaseUrl?.trim() || this.defaultBaseUrl).replace(/\/+$/, '');
  }

  private async getJson(url: string, headers: Record<string, string>): Promise<HttpResponseLike> {
    if (typeof fetch === 'function') {
      const response = await fetch(url, {
        method: 'GET',
        headers,
      });

      return {
        ok: response.ok,
        status: response.status,
        text: () => response.text(),
        json: <T>() => response.json() as Promise<T>,
      };
    }

    return this.getJsonWithNodeHttp(url, headers);
  }

  private async postJson(url: string, payload: unknown, headers: Record<string, string>): Promise<HttpResponseLike> {
    if (typeof fetch === 'function') {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      return {
        ok: response.ok,
        status: response.status,
        text: () => response.text(),
        json: <T>() => response.json() as Promise<T>,
      };
    }

    return this.postJsonWithNodeHttp(url, payload, headers);
  }

  private async postJsonWithNodeHttp(
    url: string,
    payload: unknown,
    headers: Record<string, string>
  ): Promise<HttpResponseLike> {
    const target = new URL(url);
    const body = JSON.stringify(payload);
    const isHttps = target.protocol === 'https:';
    const client = isHttps ? https : http;

    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = client.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          path: `${target.pathname}${target.search}`,
          method: 'POST',
          headers: {
            ...headers,
            'content-length': Buffer.byteLength(body).toString(),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 500,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        }
      );

      req.on('error', reject);
      req.write(body);
      req.end();
    });

    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      text: async () => result.body,
      json: async <T>() => JSON.parse(result.body) as T,
    };
  }

  private async getJsonWithNodeHttp(url: string, headers: Record<string, string>): Promise<HttpResponseLike> {
    const target = new URL(url);
    const isHttps = target.protocol === 'https:';
    const client = isHttps ? https : http;

    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = client.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 500,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        }
      );

      req.on('error', reject);
      req.end();
    });

    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      text: async () => result.body,
      json: async <T>() => JSON.parse(result.body) as T,
    };
  }

  private formatClaudeError(status: number, errorText: string, model: string): string {
    const normalized = errorText.toLowerCase();

    if (status === 401 || status === 403) {
      return `Claude authentication failed (${status}). Please check your API key and permissions.`;
    }

    if (
      normalized.includes('model_not_found') ||
      normalized.includes('no available channel') ||
      normalized.includes('not_found_error') ||
      normalized.includes('invalid model') ||
      (normalized.includes('model') && normalized.includes('not found'))
    ) {
      return `Model unavailable: ${model}. Please verify the model name in .env or via /model. Raw error: ${errorText}`;
    }

    if (status === 429) {
      return `Claude rate limit exceeded (${status}). Please retry later. Raw error: ${errorText}`;
    }

    if (status >= 500) {
      return `Claude service is temporarily unavailable (${status}). Please retry later. Raw error: ${errorText}`;
    }

    return `Claude API request failed (${status}): ${errorText}`;
  }
}
