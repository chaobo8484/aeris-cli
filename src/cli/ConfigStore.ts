import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { getLoadedEnvironmentFiles } from '../config/loadEnv.js';
import { getProviderMeta, isProviderName, ProviderName, PROVIDER_NAMES } from '../config/providerCatalog.js';

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface AppConfig {
  activeProvider: ProviderName;
  providers: Record<ProviderName, ProviderConfig>;
  trustedPaths: string[];
  projectContextEnabled: boolean;
}

export type ConfigValueSource = 'session' | 'env' | 'local' | 'default' | 'unset';

export interface ProviderConfigSources {
  apiKey: ConfigValueSource;
  baseUrl: ConfigValueSource;
  model: ConfigValueSource;
}

export interface ConfigDiagnostics {
  loadedEnvFiles: string[];
  providerSources: Record<ProviderName, ProviderConfigSources>;
  activeProviderSource: Exclude<ConfigValueSource, 'unset'>;
  projectContextEnabledSource: Exclude<ConfigValueSource, 'unset'>;
}

const DEFAULT_CONFIG: AppConfig = {
  activeProvider: 'claude',
  providers: {
    claude: {},
    openrouter: {},
  },
  trustedPaths: [],
  projectContextEnabled: true,
};

export class ConfigStore {
  private readonly configPath: string;
  private readonly appName = 'odradek-cli';
  private readonly sessionProviderOverrides: Partial<Record<ProviderName, ProviderConfig>> = {};

  constructor() {
    this.configPath = this.resolveConfigPath(this.appName);
  }

  async getConfig(): Promise<AppConfig> {
    const stored = await this.getStoredConfig();
    const withEnvironment = this.applyEnvironmentOverrides(stored);
    return this.applySessionOverrides(withEnvironment);
  }

  async getStoredConfig(): Promise<AppConfig> {
    await this.ensureConfigDir();
    try {
      const raw = await fs.readFile(this.configPath, 'utf8');
      const parsed = JSON.parse(this.stripUtf8Bom(raw)) as AppConfig;
      const parsedProviders = this.normalizeStoredProviders(parsed.providers);
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        activeProvider: isProviderName(parsed.activeProvider) ? parsed.activeProvider : DEFAULT_CONFIG.activeProvider,
        providers: parsedProviders,
        trustedPaths: Array.isArray(parsed.trustedPaths) ? parsed.trustedPaths : [],
        projectContextEnabled:
          typeof parsed.projectContextEnabled === 'boolean'
            ? parsed.projectContextEnabled
            : DEFAULT_CONFIG.projectContextEnabled,
      };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  async getConfigDiagnostics(): Promise<ConfigDiagnostics> {
    const stored = await this.getStoredConfig();
    const envProjectContextEnabled = this.readBooleanEnv(['ODRADEK_PROJECT_CONTEXT_ENABLED']);
    const envActiveProvider = this.readActiveProviderEnv();

    const providerSources = PROVIDER_NAMES.reduce<Record<ProviderName, ProviderConfigSources>>((acc, provider) => {
      const storedProvider = stored.providers[provider] ?? {};
      const sessionProvider = this.getSessionProviderConfig(provider);
      const envProvider = this.getEnvironmentProviderConfig(provider);

      acc[provider] = {
        apiKey: sessionProvider.apiKey
          ? 'session'
          : envProvider.apiKey
            ? 'env'
            : storedProvider.apiKey?.trim()
              ? 'local'
              : 'unset',
        baseUrl: sessionProvider.baseUrl
          ? 'session'
          : envProvider.baseUrl
            ? 'env'
            : storedProvider.baseUrl?.trim()
              ? 'local'
              : 'default',
        model: sessionProvider.model
          ? 'session'
          : envProvider.model
            ? 'env'
            : storedProvider.model?.trim()
              ? 'local'
              : 'unset',
      };

      return acc;
    }, {} as Record<ProviderName, ProviderConfigSources>);

    return {
      loadedEnvFiles: getLoadedEnvironmentFiles(),
      providerSources,
      activeProviderSource: envActiveProvider
        ? 'env'
        : stored.activeProvider !== DEFAULT_CONFIG.activeProvider
          ? 'local'
          : 'default',
      projectContextEnabledSource:
        typeof envProjectContextEnabled === 'boolean'
          ? 'env'
          : stored.projectContextEnabled !== DEFAULT_CONFIG.projectContextEnabled
            ? 'local'
            : 'default',
    };
  }

  async setActiveProvider(provider: ProviderName): Promise<void> {
    const current = await this.getStoredConfig();
    await this.writeConfig({
      ...current,
      activeProvider: provider,
    });
  }

  async setProjectContextEnabled(enabled: boolean): Promise<void> {
    const current = await this.getStoredConfig();
    await this.writeConfig({
      ...current,
      projectContextEnabled: enabled,
    });
  }

  async trustPath(targetPath: string): Promise<void> {
    const current = await this.getStoredConfig();
    const resolvedTarget = path.resolve(targetPath);
    const normalizedTarget = this.normalizePath(resolvedTarget);
    const exists = current.trustedPaths.some((item) => this.normalizePath(item) === normalizedTarget);

    if (exists) {
      return;
    }

    await this.writeConfig({
      ...current,
      trustedPaths: [...current.trustedPaths, resolvedTarget],
    });
  }

  async isPathTrusted(targetPath: string): Promise<boolean> {
    const current = await this.getStoredConfig();
    const normalizedTarget = this.normalizePath(path.resolve(targetPath));
    return current.trustedPaths.some((item) => this.normalizePath(item) === normalizedTarget);
  }

  getConfigPath(): string {
    return this.configPath;
  }

  setSessionProviderConfig(provider: ProviderName, config: ProviderConfig): void {
    const current = this.sessionProviderOverrides[provider] ?? {};
    const next: ProviderConfig = {
      ...current,
      ...config,
    };

    if (!next.apiKey && !next.baseUrl && !next.model) {
      delete this.sessionProviderOverrides[provider];
      return;
    }

    this.sessionProviderOverrides[provider] = next;
  }

  clearSessionProviderConfig(provider: ProviderName, keys?: Array<keyof ProviderConfig>): void {
    if (!this.sessionProviderOverrides[provider]) {
      return;
    }

    if (!keys || keys.length === 0) {
      delete this.sessionProviderOverrides[provider];
      return;
    }

    const next: ProviderConfig = { ...(this.sessionProviderOverrides[provider] ?? {}) };
    for (const key of keys) {
      delete next[key];
    }

    if (!next.apiKey && !next.baseUrl && !next.model) {
      delete this.sessionProviderOverrides[provider];
      return;
    }

    this.sessionProviderOverrides[provider] = next;
  }

  private async ensureConfigDir(): Promise<void> {
    const dir = path.dirname(this.configPath);
    await fs.mkdir(dir, { recursive: true });
  }

  private async writeConfig(config: AppConfig): Promise<void> {
    await this.ensureConfigDir();
    await fs.writeFile(this.configPath, JSON.stringify(config, null, 2), 'utf8');
  }

  private applyEnvironmentOverrides(config: AppConfig): AppConfig {
    const nextProviders = { ...config.providers };
    for (const provider of PROVIDER_NAMES) {
      const envProvider = this.getEnvironmentProviderConfig(provider);
      nextProviders[provider] = {
        ...nextProviders[provider],
        ...(envProvider.apiKey ? { apiKey: envProvider.apiKey } : {}),
        ...(envProvider.baseUrl ? { baseUrl: envProvider.baseUrl } : {}),
        ...(envProvider.model ? { model: envProvider.model } : {}),
      };
    }

    const envProjectContextEnabled = this.readBooleanEnv(['ODRADEK_PROJECT_CONTEXT_ENABLED']);
    const envActiveProvider = this.readActiveProviderEnv();

    return {
      ...config,
      activeProvider: envActiveProvider ?? config.activeProvider,
      providers: nextProviders,
      projectContextEnabled:
        typeof envProjectContextEnabled === 'boolean' ? envProjectContextEnabled : config.projectContextEnabled,
    };
  }

  private applySessionOverrides(config: AppConfig): AppConfig {
    const nextProviders = { ...config.providers };
    for (const provider of PROVIDER_NAMES) {
      const sessionProvider = this.getSessionProviderConfig(provider);
      nextProviders[provider] = {
        ...nextProviders[provider],
        ...(sessionProvider.apiKey ? { apiKey: sessionProvider.apiKey } : {}),
        ...(sessionProvider.baseUrl ? { baseUrl: sessionProvider.baseUrl } : {}),
        ...(sessionProvider.model ? { model: sessionProvider.model } : {}),
      };
    }

    return {
      ...config,
      providers: nextProviders,
    };
  }

  private getEnvironmentProviderConfig(provider: ProviderName): ProviderConfig {
    const meta = getProviderMeta(provider);
    return {
      apiKey: this.readStringEnv(meta.envKeys.apiKey),
      baseUrl: this.readStringEnv(meta.envKeys.baseUrl),
      model: this.readStringEnv(meta.envKeys.model),
    };
  }

  private readActiveProviderEnv(): ProviderName | undefined {
    const value = this.readStringEnv(['ODRADEK_ACTIVE_PROVIDER']);
    return isProviderName(value) ? value : undefined;
  }

  private getSessionProviderConfig(provider: ProviderName): ProviderConfig {
    return this.sessionProviderOverrides[provider] ?? {};
  }

  private normalizeStoredProviders(
    providers: Partial<Record<ProviderName, ProviderConfig>> | undefined
  ): Record<ProviderName, ProviderConfig> {
    const normalized = { ...DEFAULT_CONFIG.providers };

    for (const provider of PROVIDER_NAMES) {
      normalized[provider] = this.normalizeProviderConfig(providers?.[provider]);
    }

    return normalized;
  }

  private normalizeProviderConfig(config: ProviderConfig | undefined): ProviderConfig {
    if (!config) {
      return {};
    }

    return {
      ...(this.normalizeOptionalString(config.apiKey) ? { apiKey: this.normalizeOptionalString(config.apiKey) } : {}),
      ...(this.normalizeOptionalString(config.baseUrl) ? { baseUrl: this.normalizeOptionalString(config.baseUrl) } : {}),
      ...(this.normalizeOptionalString(config.model) ? { model: this.normalizeOptionalString(config.model) } : {}),
    };
  }

  private normalizeOptionalString(value: string | undefined): string | undefined {
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
  }

  private stripUtf8Bom(value: string): string {
    return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
  }

  private readStringEnv(keys: string[]): string | undefined {
    for (const key of keys) {
      const value = process.env[key]?.trim();
      if (value) {
        return value;
      }
    }
    return undefined;
  }

  private readBooleanEnv(keys: string[]): boolean | undefined {
    for (const key of keys) {
      const normalized = process.env[key]?.trim().toLowerCase();
      if (!normalized) {
        continue;
      }

      if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
      }

      if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
      }
    }

    return undefined;
  }

  private resolveConfigPath(appName: string): string {
    const home = os.homedir();
    const platform = process.platform;

    if (platform === 'win32') {
      const appData = process.env.APPDATA;
      if (appData) {
        return path.join(appData, appName, 'config.json');
      }
      return path.join(home, 'AppData', 'Roaming', appName, 'config.json');
    }

    if (platform === 'darwin') {
      return path.join(home, 'Library', 'Application Support', appName, 'config.json');
    }

    return path.join(home, '.config', appName, 'config.json');
  }

  private normalizePath(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
}
