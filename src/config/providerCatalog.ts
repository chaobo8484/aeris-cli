export type ProviderName = 'claude' | 'openrouter';

export type ProviderMeta = {
  displayName: string;
  defaultBaseUrl: string;
  envKeys: {
    apiKey: string[];
    baseUrl: string[];
    model: string[];
  };
  apiKeyPlaceholder: string;
  modelPlaceholder: string;
};

export const PROVIDER_CATALOG: Record<ProviderName, ProviderMeta> = {
  claude: {
    displayName: 'Claude',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    envKeys: {
      apiKey: ['AERIS_CLAUDE_API_KEY', 'ANTHROPIC_API_KEY'],
      baseUrl: ['AERIS_CLAUDE_BASE_URL', 'ANTHROPIC_BASE_URL'],
      model: ['AERIS_CLAUDE_MODEL'],
    },
    apiKeyPlaceholder: 'sk-ant-...',
    modelPlaceholder: 'claude-sonnet-4-20250514',
  },
  openrouter: {
    displayName: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    envKeys: {
      apiKey: ['AERIS_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'],
      baseUrl: ['AERIS_OPENROUTER_BASE_URL'],
      model: ['AERIS_OPENROUTER_MODEL'],
    },
    apiKeyPlaceholder: 'sk-or-v1-...',
    modelPlaceholder: 'provider/model-name',
  },
};

export const PROVIDER_NAMES = Object.keys(PROVIDER_CATALOG) as ProviderName[];

export function isProviderName(value: string | undefined | null): value is ProviderName {
  if (!value) {
    return false;
  }

  return value in PROVIDER_CATALOG;
}

export function getProviderMeta(provider: ProviderName): ProviderMeta {
  return PROVIDER_CATALOG[provider];
}
