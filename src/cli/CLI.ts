import readline from 'readline';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { ConversationManager } from './ConversationManager.js';
import { CommandHandler } from './CommandHandler.js';
import { UIRenderer } from './UIRenderer.js';
import { CommandRegistry } from './CommandRegistry.js';
import { AutoCompleter } from './AutoCompleter.js';
import { Spinner } from './Spinner.js';
import { ConfigDiagnostics, ConfigStore, ProviderConfigSources } from './ConfigStore.js';
import { getProviderMeta, ProviderName, PROVIDER_NAMES } from '../config/providerCatalog.js';
import { LLMClient } from '../llm/LLMClient.js';
import { createDefaultAdapters } from '../llm/adapters/createDefaultAdapters.js';
import { LLMAdapter } from '../llm/adapters/types.js';

export class CLI {
  private rl: readline.Interface;
  private conversationManager: ConversationManager;
  private commandHandler: CommandHandler;
  private uiRenderer: UIRenderer;
  private commandRegistry: CommandRegistry;
  private autoCompleter: AutoCompleter;
  private inlineSuggestionLines = 0;
  private lastInlineSuggestionQuery = '';
  private promptVisibleLines = 0;
  private readonly promptPrefix = '❯ ';
  private readonly homeAccent = chalk.hex('#CC7D5E');
  private configStore: ConfigStore;
  private llmClient: LLMClient;
  private readonly adaptersByProvider: Map<ProviderName, LLMAdapter>;
  private isInteractiveCommandActive = false;
  private commandDataHistory: Array<{ timestamp: Date; command: string; data: string }> = [];
  private isLineProcessing = false;
  private readonly onInputAssistKeypress = (_str: string, key: readline.Key): void => {
    if (!this.canRenderInlineSuggestions()) {
      return;
    }

    if ((key.ctrl && key.name === 'c') || key.name === 'return' || key.name === 'enter' || key.name === 'escape') {
      this.clearInlineSuggestions();
      return;
    }

    const baseInput = this.getCurrentReadlineInput();
    const trimmed = baseInput.trimStart();

    if (trimmed.startsWith('/') && (key.name === 'up' || key.name === 'down')) {
      if (key.name === 'up') {
        this.autoCompleter.previousSuggestion();
      } else {
        this.autoCompleter.nextSuggestion();
      }

      setImmediate(() => {
        if (this.getCurrentReadlineInput() !== baseInput) {
          this.setReadlineInput(baseInput);
        }
        this.updateInlineSuggestionsFromReadline(true);
      });
      return;
    }

    if (trimmed.startsWith('/') && key.name === 'tab') {
      const completion = this.autoCompleter.getHighlightedCompletion(trimmed);
      if (completion) {
        setImmediate(() => {
          this.setReadlineInput(completion);
          this.updateInlineSuggestionsFromReadline(true);
        });
        return;
      }
    }

    setImmediate(() => {
      this.updateInlineSuggestionsFromReadline();
    });
  };

  constructor() {
    this.commandRegistry = new CommandRegistry();
    this.autoCompleter = new AutoCompleter(this.commandRegistry);
    this.conversationManager = new ConversationManager();
    this.uiRenderer = new UIRenderer(this.conversationManager);
    this.configStore = new ConfigStore();
    const adapters = createDefaultAdapters();
    this.adaptersByProvider = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
    this.llmClient = new LLMClient(this.configStore, adapters, this.buildCommandDataContext.bind(this));

    this.commandHandler = new CommandHandler(
      this.conversationManager,
      this.uiRenderer,
      this.commandRegistry,
      this.startModelSwitchFlow.bind(this),
      this.handleProviderSwitch.bind(this),
      this.recordCommandData.bind(this),
      this.handleProjectContextCommand.bind(this),
      this.trustCurrentPath.bind(this),
      this.checkCurrentPathTrust.bind(this)
    );

    this.rl = this.createReadlineInterface();
  }

  async start() {
    this.resetTerminalView();

    const canStart = await this.ensureWorkspaceTrustBeforeStart();
    if (!canStart) {
      process.exit(0);
    }

    await this.showWelcome();
    this.setupReadline();
    this.applyBlockCursorStyle();
    this.showPrompt();
  }

  private getPromptText(): string {
    return this.promptPrefix;
  }

  private showPrompt(): void {
    if (!process.stdout.isTTY) {
      return;
    }
    const rlMaybeClosed = this.rl as readline.Interface & { closed?: boolean };
    if (rlMaybeClosed.closed) {
      return;
    }

    const divider = chalk.dim(this.getPromptDivider());
    console.log(divider);
    this.rl.setPrompt(chalk.white(this.promptPrefix));
    this.rl.prompt();
    this.promptVisibleLines = 2;
  }

  private resetTerminalView(): void {
    if (process.stdout.isTTY) {
      // Clear screen + scrollback, then move cursor to top-left.
      process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
      return;
    }
    console.clear();
  }

  private async showWelcome(): Promise<void> {
    console.clear();
    this.inlineSuggestionLines = 0;
    this.lastInlineSuggestionQuery = '';
    this.promptVisibleLines = 0;
    console.log('');
    console.log(chalk.bold('  Aeris'));
    console.log(chalk.dim('  Internal Build: v0.0.3_0'));
    console.log('');
    await this.renderHomeConfigStatus();
    await this.renderHomeProjectContextStatus();
    await this.renderHomeTrustStatus();
    console.log('');
    console.log(chalk.dim('  Type a message to start chatting'));
    console.log(
      chalk.dim('  Type ') +
        this.homeAccent('/') +
        chalk.dim(' for commands, press ') +
        this.homeAccent('Tab') +
        chalk.dim(' to autocomplete')
    );
    console.log('');
  }

  private async renderHomeConfigStatus(): Promise<void> {
    try {
      const config = await this.configStore.getConfig();
      const diagnostics = await this.configStore.getConfigDiagnostics();
      const activeProvider = config.activeProvider;
      const providerMeta = getProviderMeta(activeProvider);
      const providerConfig = config.providers[activeProvider] ?? {};
      const apiKey = providerConfig.apiKey?.trim();
      const currentModel = providerConfig.model?.trim();
      const currentBaseUrl = providerConfig.baseUrl?.trim() || providerMeta.defaultBaseUrl;
      const sourceSummary = this.summarizeProviderConfigSource(diagnostics.providerSources[activeProvider]);

      if (apiKey && currentModel) {
        console.log(chalk.green('  Model Config: ready'));
        console.log(chalk.dim('  Active provider: ') + this.homeAccent(providerMeta.displayName));
        console.log(chalk.dim('  Config source: ') + this.homeAccent(sourceSummary));
        console.log(chalk.dim('  Current model: ') + this.homeAccent(currentModel));
        console.log(chalk.dim('  Base URL: ') + this.homeAccent(currentBaseUrl));
        this.renderEnvironmentStatusLines(diagnostics, activeProvider);
        return;
      }

      console.log(chalk.yellow('  Model Config: incomplete'));
      console.log(chalk.dim('  Active provider: ') + this.homeAccent(providerMeta.displayName));
      if (!apiKey) {
        console.log(
          chalk.dim('  Set ') +
            this.homeAccent(providerMeta.envKeys.apiKey.join(' / ')) +
            chalk.dim(' in .env to finish setup')
        );
      }
      if (!currentModel) {
        console.log(
          chalk.dim('  Set ') +
            this.homeAccent(providerMeta.envKeys.model.join(' / ')) +
            chalk.dim(' or run ') +
            this.homeAccent('/model <model-name>') +
            chalk.dim(' to finish setup')
        );
      }
      console.log(chalk.dim('  Current Base URL: ') + this.homeAccent(currentBaseUrl));
      this.renderEnvironmentStatusLines(diagnostics, activeProvider);
    } catch {
      console.log(chalk.red('  Failed to read model configuration state'));
      console.log(chalk.dim('  Check your .env and restart the CLI'));
    }
  }

  private async renderHomeProjectContextStatus(): Promise<void> {
    try {
      const config = await this.configStore.getConfig();
      const enabled = config.projectContextEnabled;
      const state = enabled ? chalk.green('enabled') : chalk.yellow('disabled');
      console.log(chalk.dim('  Project Context: ') + state);
      console.log(
        chalk.dim('  Toggle with ') +
          this.homeAccent('/projectcontext on') +
          chalk.dim(' / ') +
          this.homeAccent('/projectcontext off')
      );
    } catch {
      console.log(chalk.red('  Project Context: failed to read config'));
    }
  }

  private async ensureWorkspaceTrustBeforeStart(): Promise<boolean> {
    const currentPath = process.cwd();
    const trusted = await this.configStore.isPathTrusted(currentPath);
    if (trusted) {
      return true;
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.log(chalk.yellow('Workspace trust required before starting CLI.'));
      console.log(chalk.dim(`Current path: ${currentPath}`));
      console.log(chalk.dim('Run in interactive mode and trust this directory first.'));
      return false;
    }

    this.renderWorkspaceTrustPrompt(currentPath);

    try {
      const { decision } = await inquirer.prompt<{ decision: 'trust' | 'exit' }>([
        {
          type: 'list',
          name: 'decision',
          message: 'Select an option',
          choices: [
            { name: 'Yes, I trust this folder', value: 'trust' },
            { name: 'No, exit', value: 'exit' },
          ],
          default: 'trust',
          pageSize: 2,
        },
      ]);

      if (decision === 'trust') {
        await this.configStore.trustPath(currentPath);
        console.log(chalk.green('\nTrusted current directory. Starting CLI...\n'));
        return true;
      }

      console.log(chalk.yellow('\nTrust not granted. Exiting.\n'));
      return false;
    } catch (error) {
      if (this.isPromptCancelError(error)) {
        console.log(chalk.yellow('\nTrust prompt canceled. Exiting.\n'));
        return false;
      }
      throw error;
    }
  }

  private renderWorkspaceTrustPrompt(currentPath: string): void {
    const divider = chalk.yellow(this.getPromptDivider());
    console.log(divider);
    console.log(chalk.yellow.bold('Accessing workspace:'));
    console.log('');
    console.log(chalk.white(currentPath));
    console.log('');
    console.log(
      chalk.gray(
        "Quick safety check: Is this a project you created or one you trust? If not, review this folder before continuing."
      )
    );
    console.log('');
    console.log(chalk.gray("Aeris will be able to read, edit, and execute files here."));
    console.log('');
    console.log(chalk.gray('Security guide'));
    console.log('');
  }

  private async renderHomeTrustStatus(): Promise<void> {
    const currentPath = process.cwd();
    try {
      const trusted = await this.configStore.isPathTrusted(currentPath);
      const status = trusted ? chalk.green('trusted') : chalk.yellow('not trusted');
      console.log(chalk.dim('  Trust Check: ') + status);
      console.log(chalk.dim('  Current path: ') + this.homeAccent(currentPath));
      if (!trusted) {
        console.log(chalk.dim('  Run ') + this.homeAccent('/trustpath') + chalk.dim(' to trust this directory'));
      }
    } catch {
      console.log(chalk.red('  Trust Check: failed'));
    }
  }

  private setupReadline(): void {
    this.bindLineModeHandlers();
    this.bindInputAssistHandlers();
  }

  private createReadlineInterface(): readline.Interface {
    const isTerminal = Boolean(process.stdout.isTTY);
    return readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.cyan(this.getPromptText()),
      completer: this.autoCompleter.completer.bind(this.autoCompleter),
      terminal: isTerminal,
    });
  }

  private bindLineModeHandlers(): void {
    this.rl.removeAllListeners('line');
    this.rl.removeAllListeners('SIGINT');

    this.rl.on('line', async (line) => {
      this.isLineProcessing = true;
      try {
        this.clearInlineSuggestions();
        this.clearPromptEchoBlock();
        const input = line.trim();
        if (input) {
          await this.handleInput(input);
        }
      } finally {
        this.isLineProcessing = false;
        if (!this.isInteractiveCommandActive) {
          this.showPrompt();
        }
      }
    });

    this.rl.on('SIGINT', () => {
      this.exitWithFarewell();
    });
  }

  private bindInputAssistHandlers(): void {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return;
    }

    readline.emitKeypressEvents(process.stdin, this.rl);
    process.stdin.removeListener('keypress', this.onInputAssistKeypress);
    process.stdin.on('keypress', this.onInputAssistKeypress);
  }

  private getCurrentReadlineInput(): string {
    const rlWithLine = this.rl as readline.Interface & { line?: string };
    return typeof rlWithLine.line === 'string' ? rlWithLine.line : '';
  }

  private updateInlineSuggestionsFromReadline(force = false): void {
    if (!this.canRenderInlineSuggestions()) {
      return;
    }

    const line = this.getCurrentReadlineInput();
    const trimmed = line.trimStart();

    if (!trimmed.startsWith('/')) {
      this.clearInlineSuggestions();
      this.lastInlineSuggestionQuery = '';
      return;
    }

    const query = trimmed.slice(1).toLowerCase();
    if (!force && query === this.lastInlineSuggestionQuery && this.inlineSuggestionLines > 0) {
      return;
    }

    const lines = this.autoCompleter.getSuggestionLines(trimmed, 6);
    this.renderInlineSuggestions(lines);
    this.lastInlineSuggestionQuery = query;
  }

  private renderInlineSuggestions(lines: string[]): void {
    if (!this.canRenderInlineSuggestions()) {
      return;
    }

    this.clearInlineSuggestions();
    if (lines.length === 0) {
      return;
    }

    const safeLines = this.fitSuggestionLinesToTerminal(lines);
    const promptWidth = this.getDisplayWidth(this.promptPrefix);
    const inputWidth = this.getDisplayWidth(this.getCurrentReadlineInput());

    readline.moveCursor(process.stdout, 0, 1);
    safeLines.forEach((line, index) => {
      readline.clearLine(process.stdout, 0);
      process.stdout.write(line);
      if (index < safeLines.length - 1) {
        process.stdout.write('\n');
      }
    });

    readline.moveCursor(process.stdout, 0, -safeLines.length);
    readline.cursorTo(process.stdout, promptWidth + inputWidth);

    this.inlineSuggestionLines = safeLines.length;
  }

  private clearInlineSuggestions(): void {
    if (!process.stdout.isTTY || this.inlineSuggestionLines === 0 || this.promptVisibleLines === 0) {
      return;
    }

    const promptWidth = this.getDisplayWidth(this.promptPrefix);
    const inputWidth = this.getDisplayWidth(this.getCurrentReadlineInput());

    readline.moveCursor(process.stdout, 0, 1);
    for (let i = 0; i < this.inlineSuggestionLines; i++) {
      readline.clearLine(process.stdout, 0);
      if (i < this.inlineSuggestionLines - 1) {
        readline.moveCursor(process.stdout, 0, 1);
      }
    }

    readline.moveCursor(process.stdout, 0, -this.inlineSuggestionLines);
    readline.cursorTo(process.stdout, promptWidth + inputWidth);
    this.inlineSuggestionLines = 0;
  }

  private clearSuggestions(): void {
    this.clearInlineSuggestions();
    this.autoCompleter.resetSuggestions();
    this.lastInlineSuggestionQuery = '';
  }

  private clearPromptEchoBlock(): void {
    if (!process.stdout.isTTY) {
      return;
    }

    const rlMaybeClosed = this.rl as readline.Interface & { closed?: boolean };
    if (rlMaybeClosed.closed) {
      return;
    }

    if (this.promptVisibleLines <= 0) {
      return;
    }

    // Remove only the visible prompt block (divider + prompt line), do not erase chat content above it.
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);

    for (let i = 1; i < this.promptVisibleLines; i++) {
      readline.moveCursor(process.stdout, 0, -1);
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
    }

    this.promptVisibleLines = 0;
  }

  private canRenderInlineSuggestions(): boolean {
    return Boolean(
      process.stdin.isTTY &&
        process.stdout.isTTY &&
        !this.isInteractiveCommandActive &&
        !this.isLineProcessing &&
        this.promptVisibleLines > 0
    );
  }

  private setReadlineInput(value: string): void {
    this.rl.write(null, { ctrl: true, name: 'u' });
    this.rl.write(value);
  }

  private fitSuggestionLinesToTerminal(lines: string[]): string[] {
    const columns = Math.max(20, (process.stdout.columns ?? 120) - 1);
    return lines.map((line) => this.truncateAnsiLine(line, columns));
  }

  private truncateAnsiLine(input: string, maxWidth: number): string {
    if (maxWidth <= 0) {
      return '';
    }

    const ansiPattern = /\x1b\[[0-9;]*m/g;
    const textOnly = input.replace(ansiPattern, '');
    if (this.getDisplayWidth(textOnly) <= maxWidth) {
      return input;
    }

    const suffix = maxWidth >= 3 ? '...' : '.';
    const targetWidth = Math.max(0, maxWidth - this.getDisplayWidth(suffix));

    let visible = '';
    for (const ch of Array.from(textOnly)) {
      const next = visible + ch;
      if (this.getDisplayWidth(next) > targetWidth) {
        break;
      }
      visible = next;
    }

    return visible + suffix;
  }

  private async handleInput(input: string): Promise<void> {
    this.clearInlineSuggestions();
    this.lastInlineSuggestionQuery = '';

    if (input.startsWith('/')) {
      const normalizedCommand = input.slice(1).trim().split(/\s+/)[0]?.toLowerCase() || 'unknown';
      const safeInput = this.maskSensitiveCommandInput(input);
      this.recordCommandData(normalizedCommand, `invoked ${safeInput}`);
      this.uiRenderer.renderCommandInvocation(safeInput);
      await this.commandHandler.handleCommand(input);
      if (normalizedCommand === 'clear') {
        this.commandDataHistory = [];
      }
      return;
    }

    this.conversationManager.addMessage('user', input);
    this.uiRenderer.renderLastMessage();

    const spinner = new Spinner();
    console.log('');
    spinner.start('Thinking...');

    try {
      const response = await this.llmClient.generateReply(this.conversationManager.getMessages());
      spinner.stop();
      const config = await this.configStore.getConfig();
      const activeProvider = config.activeProvider;
      const modelLabel = config.providers[activeProvider]?.model?.trim();
      this.conversationManager.addMessage(
        'assistant',
        response.content,
        response.appendix || modelLabel
          ? {
              ...(response.appendix ? { appendix: response.appendix } : {}),
              ...(modelLabel ? { modelLabel } : {}),
            }
          : undefined
      );
      this.uiRenderer.renderLastMessage();
    } catch (error) {
      spinner.stop();
      const message = error instanceof Error ? error.message : 'Model request failed. Please check config or network.';
      this.uiRenderer.renderError(message);
    }
  }

  private maskSensitiveCommandInput(input: string): string {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) {
      return input;
    }

    const [command, ...rest] = trimmed.slice(1).split(/\s+/);
    const normalizedCommand = command?.toLowerCase() || '';

    return input;
  }

  private recordCommandData(command: string, data: string): void {
    const normalizedCommand = command.trim().toLowerCase() || 'unknown';
    const normalizedData = data.replace(/\r\n/g, '\n').trim();
    if (!normalizedData) {
      return;
    }

    const maxDataChars = 3500;
    const cappedData =
      normalizedData.length > maxDataChars ? `${normalizedData.slice(0, maxDataChars)}\n...(truncated)` : normalizedData;

    this.commandDataHistory.push({
      timestamp: new Date(),
      command: normalizedCommand,
      data: cappedData,
    });

    const maxEntries = 200;
    if (this.commandDataHistory.length > maxEntries) {
      this.commandDataHistory = this.commandDataHistory.slice(this.commandDataHistory.length - maxEntries);
    }
  }

  private buildCommandDataContext(): string {
    const selected = this.commandDataHistory.slice(-60);
    if (selected.length === 0) {
      return '';
    }

    const lines = selected.flatMap((entry) => [
      `[${entry.timestamp.toISOString()}] /${entry.command}`,
      entry.data,
      '',
    ]);

    const merged = ['Command data history:', ...lines].join('\n').trim();
    const maxChars = 18000;
    if (merged.length <= maxChars) {
      return merged;
    }

    return `Command data history:\n...(truncated)\n${merged.slice(merged.length - maxChars)}`;
  }

  private async handleProviderSwitch(args: string[]): Promise<void> {
    const invokedCommand = args.length > 0 ? `/provider ${args.join(' ')}` : '/provider';

    try {
      const config = await this.configStore.getConfig();
      const diagnostics = await this.configStore.getConfigDiagnostics();
      const currentProvider = config.activeProvider;
      let targetProvider: ProviderName | undefined;

      if (args.length > 0) {
        const rawInput = args.join(' ').trim().toLowerCase();
        if (!rawInput) {
          await this.refreshHomeAfterModelCommand(invokedCommand, `Active provider: ${getProviderMeta(currentProvider).displayName}`);
          return;
        }

        const matched = PROVIDER_NAMES.find((provider) => provider === rawInput);
        if (!matched) {
          this.uiRenderer.renderError(`Unknown provider: ${rawInput}`);
          this.uiRenderer.renderInfo(`Available providers: ${PROVIDER_NAMES.join(', ')}`);
          this.recordCommandData('provider', `failed: unknown provider: ${rawInput}`);
          return;
        }

        targetProvider = matched;
      } else {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          this.uiRenderer.renderError('Interactive provider selection requires a TTY. Use /provider <name> instead.');
          this.recordCommandData('provider', 'failed: Interactive provider selection requires a TTY.');
          return;
        }

        this.isInteractiveCommandActive = true;
        this.clearSuggestions();
        const { selectedProvider } = await inquirer.prompt<{ selectedProvider: ProviderName }>([
          {
            type: 'list',
            name: 'selectedProvider',
            message: 'Select the active provider',
            choices: PROVIDER_NAMES.map((provider) => ({
              name:
                provider === currentProvider
                  ? `${getProviderMeta(provider).displayName} (current)`
                  : getProviderMeta(provider).displayName,
              value: provider,
            })),
            default: currentProvider,
          },
        ]);
        targetProvider = selectedProvider;
      }

      if (!targetProvider || targetProvider === currentProvider) {
        await this.refreshHomeAfterModelCommand(invokedCommand, `Provider unchanged: ${getProviderMeta(currentProvider).displayName}`);
        return;
      }

      await this.configStore.setActiveProvider(targetProvider);
      const result =
        diagnostics.activeProviderSource === 'env'
          ? `Active provider saved as ${getProviderMeta(targetProvider).displayName} (env override is still active)`
          : `Active provider switched: ${getProviderMeta(currentProvider).displayName} -> ${getProviderMeta(targetProvider).displayName}`;
      await this.refreshHomeAfterModelCommand(invokedCommand, result);
    } catch (error) {
      if (this.isPromptCancelError(error)) {
        this.uiRenderer.renderCommandResult('Provider switch canceled');
        this.recordCommandData('provider', 'Provider switch canceled');
        return;
      }
      const message = error instanceof Error ? error.message : 'Failed to switch provider';
      this.uiRenderer.renderError(message);
      this.recordCommandData('provider', `failed: ${message}`);
    } finally {
      this.isInteractiveCommandActive = false;
      this.autoCompleter.resetSuggestions();
      this.applyBlockCursorStyle();
      this.ensureInputReadyAfterConfig();
    }
  }

  private async startModelSwitchFlow(args: string[]): Promise<void> {
    this.isInteractiveCommandActive = true;
    this.clearSuggestions();

    try {
      const invokedCommand = args.length > 0 ? `/model ${args.join(' ')}` : '/model';
      const config = await this.configStore.getConfig();
      const diagnostics = await this.configStore.getConfigDiagnostics();
      const provider = config.activeProvider;
      const providerMeta = getProviderMeta(provider);
      const providerConfig = config.providers[provider] ?? {};
      const apiKey = providerConfig.apiKey?.trim();
      if (!apiKey) {
        this.uiRenderer.renderError(
          `${providerMeta.displayName} API key is missing. Set ${providerMeta.envKeys.apiKey.join(' / ')} in .env first.`
        );
        this.recordCommandData(
          'model',
          `failed: ${providerMeta.displayName} API key is missing. Set ${providerMeta.envKeys.apiKey.join(' / ')} in .env first.`
        );
        return;
      }

      const currentBaseUrl = providerConfig.baseUrl?.trim() || providerMeta.defaultBaseUrl;
      const currentEffectiveModelValue = providerConfig.model?.trim() || '';
      const currentEffectiveModel = currentEffectiveModelValue || 'Not set';
      const isSessionModelOverrideActive = diagnostics.providerSources[provider].model === 'session';
      let targetModel: string | undefined;

      if (args.length > 0) {
        const rawInput = args.join(' ').trim();
        if (!rawInput) {
          await this.refreshHomeAfterModelCommand(invokedCommand, `Current model: ${currentEffectiveModel}`);
          return;
        }

        const normalizedInput = rawInput.toLowerCase();
        if (normalizedInput === 'clear' || normalizedInput === 'reset' || normalizedInput === 'default' || normalizedInput === 'unset') {
          if (!isSessionModelOverrideActive) {
            await this.refreshHomeAfterModelCommand(
              invokedCommand,
              `No session model override is active. Current model: ${currentEffectiveModel}`
            );
            return;
          }

          this.configStore.clearSessionProviderConfig(provider, ['model']);
          const nextConfig = await this.configStore.getConfig();
          const nextModel = nextConfig.providers[provider]?.model?.trim() || 'Not set';
          await this.refreshHomeAfterModelCommand(invokedCommand, `Session model cleared. Active model: ${nextModel}`);
          return;
        }

        if (provider === 'openrouter') {
          targetModel = rawInput;
        } else {
          const availableModels = await this.fetchAvailableModels(provider, currentBaseUrl, apiKey);
          if (!availableModels.includes(rawInput)) {
            const preview = availableModels.slice(0, 10).join(', ');
            const suffix = availableModels.length > 10 ? ', ...' : '';
            this.uiRenderer.renderError(`${providerMeta.displayName} model not available for current API key: ${rawInput}`);
            this.uiRenderer.renderInfo(`Available models: ${preview}${suffix}`);
            this.recordCommandData('model', `failed: model not available: ${rawInput}`);
            return;
          }
          targetModel = rawInput;
        }
      } else {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          this.uiRenderer.renderError('Interactive model selection requires a TTY. Use /model <model-name> instead.');
          this.recordCommandData('model', 'failed: Interactive model selection requires a TTY.');
          return;
        }

        if (provider === 'openrouter') {
          const { enteredModel } = await inquirer.prompt<{ enteredModel: string }>([
            {
              type: 'input',
              name: 'enteredModel',
              message: `Current model: ${currentEffectiveModel}. Enter the OpenRouter model name`,
              default: currentEffectiveModelValue || providerMeta.modelPlaceholder,
              validate: (value: string) => Boolean(value.trim()) || 'Model name cannot be empty',
            },
          ]);

          const normalizedEntered = enteredModel.trim();
          if (normalizedEntered === currentEffectiveModelValue) {
            await this.refreshHomeAfterModelCommand(invokedCommand, `Model unchanged: ${currentEffectiveModel}`);
            return;
          }

          targetModel = normalizedEntered;
        } else {
          const availableModels = await this.fetchAvailableModels(provider, currentBaseUrl, apiKey);
          if (availableModels.length === 0) {
            this.uiRenderer.renderError('No available models returned by current API endpoint.');
            this.recordCommandData('model', 'failed: No available models returned by current API endpoint.');
            return;
          }

          const { selectedModel } = await inquirer.prompt<{ selectedModel: string }>([
            {
              type: 'list',
              name: 'selectedModel',
              message: `Current model: ${currentEffectiveModel}. Select target model`,
              choices: availableModels.map((modelName) => ({
                name: modelName === currentEffectiveModel ? `${modelName} (current)` : modelName,
                value: modelName,
              })),
              default: availableModels.includes(currentEffectiveModel) ? currentEffectiveModel : availableModels[0],
              pageSize: Math.min(15, availableModels.length),
            },
          ]);

          if (selectedModel === currentEffectiveModel) {
            await this.refreshHomeAfterModelCommand(invokedCommand, `Model unchanged: ${currentEffectiveModel}`);
            return;
          }

          targetModel = selectedModel;
        }
      }

      const previousEffectiveModel = currentEffectiveModel;
      const nextEffectiveModel = targetModel?.trim() || 'Not set';
      const normalizedTarget = targetModel?.trim() || '';
      const isSameConfiguredValue = currentEffectiveModelValue === normalizedTarget;

      if (isSameConfiguredValue) {
        await this.refreshHomeAfterModelCommand(invokedCommand, `Model unchanged: ${previousEffectiveModel}`);
        return;
      }

      this.configStore.setSessionProviderConfig(provider, { model: targetModel });
      await this.refreshHomeAfterModelCommand(
        invokedCommand,
        `Session model switched: ${previousEffectiveModel} -> ${nextEffectiveModel}`
      );
    } catch (error) {
      if (this.isPromptCancelError(error)) {
        this.uiRenderer.renderCommandResult('Model switch canceled');
        this.recordCommandData('model', 'Model switch canceled');
        return;
      }
      const message = error instanceof Error ? error.message : 'Failed to switch model';
      this.uiRenderer.renderError(message);
      this.recordCommandData('model', `failed: ${message}`);
    } finally {
      this.isInteractiveCommandActive = false;
      this.autoCompleter.resetSuggestions();
      this.applyBlockCursorStyle();
      this.ensureInputReadyAfterConfig();
    }
  }

  private async refreshHomeAfterModelCommand(command: string, result: string): Promise<void> {
    await this.showWelcome();
    this.uiRenderer.renderCommandInvocation(command);
    this.uiRenderer.renderCommandResult(result);
    const normalizedCommand = command.startsWith('/') ? command.slice(1).split(/\s+/)[0] : command;
    this.recordCommandData(normalizedCommand, result);
  }

  private async handleProjectContextCommand(args: string[]): Promise<void> {
    const invoked = args.length > 0 ? `/projectcontext ${args.join(' ')}` : '/projectcontext';
    const action = args[0]?.trim().toLowerCase() ?? 'status';

    if (action === 'status') {
      const config = await this.configStore.getConfig();
      const state = config.projectContextEnabled ? 'enabled' : 'disabled';
      await this.refreshHomeAfterModelCommand(invoked, `Project context is ${state}`);
      return;
    }

    if (action === 'on' || action === 'enable') {
      await this.configStore.setProjectContextEnabled(true);
      await this.refreshHomeAfterModelCommand(invoked, 'Project context enabled');
      return;
    }

    if (action === 'off' || action === 'disable') {
      await this.configStore.setProjectContextEnabled(false);
      await this.refreshHomeAfterModelCommand(invoked, 'Project context disabled');
      return;
    }

    this.uiRenderer.renderError('Usage: /projectcontext [on|off|status]');
    this.recordCommandData('projectcontext', 'Usage: /projectcontext [on|off|status]');
  }

  private async fetchAvailableModels(provider: ProviderName, baseUrl: string, apiKey: string): Promise<string[]> {
    const normalizedBase = baseUrl.replace(/\/+$/, '');

    // Enforce HTTPS to prevent API key transmission over plain HTTP.
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(normalizedBase);
    } catch {
      throw new Error(`Invalid Base URL: ${normalizedBase}`);
    }
    if (parsedUrl.protocol !== 'https:') {
      throw new Error(`Base URL must use HTTPS (got: ${parsedUrl.protocol}). Refusing to send API key over insecure connection.`);
    }

    const adapter = this.adaptersByProvider.get(provider);
    if (!adapter) {
      throw new Error(`${getProviderMeta(provider).displayName} adapter not found.`);
    }

    return adapter.listModels({ apiKey, baseUrl: normalizedBase });
  }

  private ensureInputReadyAfterConfig(): void {
    try {
      process.stdin.resume();
    } catch {
      // Ignore stdin resume errors.
    }

    const rlMaybeClosed = this.rl as readline.Interface & { closed?: boolean };
    if (rlMaybeClosed.closed) {
      this.rl = this.createReadlineInterface();
      this.bindLineModeHandlers();
      this.bindInputAssistHandlers();
    }
  }

  private getPromptDivider(): string {
    const width = process.stdout.columns ?? 80;
    return '─'.repeat(width);
  }

  private applyBlockCursorStyle(): void {
    if (process.stdout.isTTY) {
      process.stdout.write('\x1b[2 q');
    }
  }

  private getDisplayWidth(text: string): number {
    let width = 0;
    for (const char of Array.from(text)) {
      width += this.getCharDisplayWidth(char);
    }
    return width;
  }

  private getCharDisplayWidth(char: string): number {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) return 0;

    // Control chars.
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return 0;

    // Combining marks.
    if (
      (codePoint >= 0x0300 && codePoint <= 0x036f) ||
      (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
      (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
      (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
      (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
    ) {
      return 0;
    }

    // Wide characters (CJK, Hangul, full-width forms, most emoji).
    if (
      codePoint >= 0x1100 &&
      (codePoint <= 0x115f ||
        codePoint === 0x2329 ||
        codePoint === 0x232a ||
        (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
        (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
        (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
        (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
        (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
        (codePoint >= 0xff00 && codePoint <= 0xff60) ||
        (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
        (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
        (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
        (codePoint >= 0x20000 && codePoint <= 0x3fffd))
    ) {
      return 2;
    }

    return 1;
  }

  private renderEnvironmentStatusLines(diagnostics: ConfigDiagnostics, provider: ProviderName): void {
    const providerSources = diagnostics.providerSources[provider];
    const envOverrides = this.getEnvironmentOverrideLabels(providerSources);
    const sessionOverrides = this.getSessionOverrideLabels(providerSources);

    if (diagnostics.loadedEnvFiles.length > 0) {
      console.log(chalk.dim('  Loaded env files: ') + this.homeAccent(diagnostics.loadedEnvFiles.join(', ')));
    }

    if (diagnostics.activeProviderSource === 'env') {
      console.log(chalk.yellow('  Environment override active: ') + chalk.white('Active Provider'));
      console.log(chalk.dim('  Runtime active provider is currently controlled by AERIS_ACTIVE_PROVIDER'));
    }

    if (envOverrides.length > 0 || diagnostics.projectContextEnabledSource === 'env') {
      const segments = [...envOverrides];
      if (diagnostics.projectContextEnabledSource === 'env') {
        segments.push('Project Context');
      }

      console.log(chalk.yellow('  Environment override active: ') + chalk.white(segments.join(', ')));
      console.log(chalk.dim('  Runtime provider settings come from process.env/.env'));
    }

    if (sessionOverrides.length > 0) {
      console.log(chalk.green('  Session override active: ') + chalk.white(sessionOverrides.join(', ')));
      console.log(chalk.dim('  Use ') + this.homeAccent('/model clear') + chalk.dim(' to return to the configured default model'));
    }
  }

  private getEnvironmentOverrideLabels(sources: ProviderConfigSources): string[] {
    const labels: string[] = [];

    if (sources.apiKey === 'env') {
      labels.push('API Key');
    }

    if (sources.baseUrl === 'env') {
      labels.push('Base URL');
    }

    if (sources.model === 'env') {
      labels.push('Model');
    }

    return labels;
  }

  private getSessionOverrideLabels(sources: ProviderConfigSources): string[] {
    const labels: string[] = [];

    if (sources.apiKey === 'session') {
      labels.push('API Key');
    }

    if (sources.baseUrl === 'session') {
      labels.push('Base URL');
    }

    if (sources.model === 'session') {
      labels.push('Model');
    }

    return labels;
  }

  private summarizeProviderConfigSource(sources: ProviderConfigSources): string {
    const runtimeSources = Array.from(
      new Set(
        [sources.apiKey, sources.baseUrl, sources.model].filter(
          (item) => item === 'session' || item === 'env' || item === 'local'
        )
      )
    );

    if (runtimeSources.length === 0) {
      return 'not configured';
    }

    if (runtimeSources.length === 1) {
      return this.describeRuntimeSource(runtimeSources[0]);
    }

    return `mixed (${runtimeSources.map((item) => this.describeRuntimeSource(item)).join(' + ')})`;
  }

  private describeRuntimeSource(source: 'session' | 'env' | 'local'): string {
    if (source === 'session') {
      return 'session override';
    }

    if (source === 'env') {
      return 'environment';
    }

    return 'local config file';
  }

  private isPromptCancelError(error: unknown): boolean {
    return error instanceof Error && error.name === 'ExitPromptError';
  }

  private exitWithFarewell(): never {
    console.log('\nBye!');
    process.exit(0);
  }

  private async trustCurrentPath(): Promise<void> {
    const currentPath = process.cwd();
    try {
      const trusted = await this.configStore.isPathTrusted(currentPath);
      if (trusted) {
        this.uiRenderer.renderCommandResult(`Current directory is already trusted: ${currentPath}`);
        this.recordCommandData('trustpath', `Current directory is already trusted: ${currentPath}`);
        return;
      }

      await this.configStore.trustPath(currentPath);
      this.uiRenderer.renderCommandResult(`Trusted current directory: ${currentPath}`);
      this.recordCommandData('trustpath', `Trusted current directory: ${currentPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to trust current directory';
      this.uiRenderer.renderError(message);
      this.recordCommandData('trustpath', `failed: ${message}`);
    }
  }

  private async checkCurrentPathTrust(): Promise<void> {
    const currentPath = process.cwd();
    try {
      const trusted = await this.configStore.isPathTrusted(currentPath);
      if (trusted) {
        this.uiRenderer.renderCommandResult(`Trust check passed: ${currentPath}`);
        this.recordCommandData('trustcheck', `Trust check passed: ${currentPath}`);
        return;
      }

      this.uiRenderer.renderCommandResult(`Trust check failed: ${currentPath} (run /trustpath)`);
      this.recordCommandData('trustcheck', `Trust check failed: ${currentPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to verify trust status';
      this.uiRenderer.renderError(message);
      this.recordCommandData('trustcheck', `failed: ${message}`);
    }
  }

  stop(): void {
    this.rl.close();
  }
}
