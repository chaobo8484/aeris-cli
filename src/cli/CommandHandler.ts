import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import chalk from 'chalk';
import boxen from 'boxen';
import { ConversationManager } from './ConversationManager.js';
import { UIRenderer } from './UIRenderer.js';
import { CommandRegistry } from './CommandRegistry.js';
import { ConfigStore } from './ConfigStore.js';
import { Spinner } from './Spinner.js';
import { PromptAssetCategory, PromptAssetScanner } from './PromptAssetScanner.js';
import { SkillScanner, SkillScanResult, SkillSummary } from './SkillScanner.js';
import { ContextNoiseAnalysis, ContextNoiseAnalyzer, ContextNoiseReadRecord } from './ContextNoiseAnalyzer.js';
import { TodoGranularityAnalysis, TodoGranularityAnalyzer } from './TodoGranularityAnalyzer.js';
import { estimateTokenCount } from './tokenEstimate.js';
import { ClaudeTokenizer } from '../llm/ClaudeTokenizer.js';

type ContextAnatomySegmentKey = 'system' | 'prompt_library' | 'reference_docs' | 'chat_history' | 'active_request';

type ContextActionSeverity = 'stable' | 'watch' | 'trim';

type ContextAnatomySegment = {
  key: ContextAnatomySegmentKey;
  label: string;
  shortLabel: string;
  tokenCount: number;
  shareOfInput: number;
  shareOfWindow: number;
  itemCount: number;
  colorize: (value: string) => string;
  barChar: string;
  note: string;
  severity: ContextActionSeverity;
};

type ContextAnatomyDriver = {
  label: string;
  tokenCount: number;
  shareOfInput: number;
  shareOfWindow: number;
  kind: string;
  colorize: (value: string) => string;
};

type ContextAnatomyView = {
  lines: string[];
  recommendations: string[];
  summary: string[];
};

type AnatomyBucket = {
  name: string;
  tokenCount: number;
  percent: number;
  colorize: (value: string) => string;
  fillChar?: '█' | '▓';
  warning?: boolean;
};

type TokenScanScope = 'current' | 'all' | 'path';

type TokenScanRequest = {
  scope: TokenScanScope;
  rawPath?: string;
};

type TokenFieldAggregate = {
  name: string;
  total: number;
  count: number;
};

type TokenGroupAggregate = {
  name: string;
  totalTokens: number;
  records: number;
};

type TokenDayAggregate = {
  day: string;
  totalTokens: number;
  records: number;
};

type TokenFileAggregate = {
  filePath: string;
  projectDir: string;
  totalLines: number;
  parsedLines: number;
  invalidLines: number;
  recordsWithTokens: number;
  totalTokens: number;
  latestTimestampMs: number;
};

type TokenStructureSummary = {
  files: TokenFileAggregate[];
  totalFiles: number;
  totalLines: number;
  parsedLines: number;
  invalidLines: number;
  recordsWithTokens: number;
  totalTokens: number;
  tokenFields: TokenFieldAggregate[];
  roleBreakdown: TokenGroupAggregate[];
  typeBreakdown: TokenGroupAggregate[];
  dayBreakdown: TokenDayAggregate[];
};

type TokenScanTarget = {
  scopeLabel: string;
  sourceLabel: string;
  projectDirs: string[];
  filePaths: string[];
};

type ContextHealthLevel = 'healthy' | 'elevated' | 'critical' | 'unknown';
type ContextHealthConfidence = 'high' | 'medium' | 'low';

type ContextUsageRecord = {
  timestampMs: number;
  timestampLabel: string;
  filePath: string;
  model: string;
  contextUsedPercent: number | null;
  contextWindowTokens: number | null;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
};

type ContextHealthSnapshot = {
  level: ContextHealthLevel;
  levelReason: string;
  confidence: ContextHealthConfidence;
  confidenceReason: string;
  source: 'native' | 'calculated';
  model: string;
  rawPercent: number;
  effectivePercent: number;
  smoothedEffectivePercent: number;
  trendDeltaPercent: number | null;
  dataPoints: number;
  usedTokens: number;
  contextWindowTokens: number;
  usableContextTokens: number;
  autocompactBufferTokens: number;
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  timestampLabel: string;
  filePath: string;
};

type PromptCoverageItem = {
  relativePath: string;
  fullPath: string;
  kind: 'prompt' | 'skill';
  label: string;
  tokenCount: number;
  summary: string;
  headings: string[];
  read: boolean;
  readTokens: number;
  wasReferencedLater: boolean;
};

type PromptCoverageSignalKind = 'high_value' | 'read_only' | 'unused';

type PromptCoverageSignal = {
  kind: PromptCoverageSignalKind;
  severity: 'high' | 'medium' | 'low';
  tokenImpact: number;
  reason: string;
  asset: PromptCoverageItem;
};

type PromptCoverageSummary = {
  scannedAssets: number;
  readAssets: PromptCoverageItem[];
  unreadAssets: PromptCoverageItem[];
  highValueAssets: PromptCoverageItem[];
  matchedReadCount: number;
  scannedPromptFiles: number;
  scannedSkills: number;
  promptNoiseTokens: number;
  signals: PromptCoverageSignal[];
};

type PromptScanTokenizerMode = 'count_tokens' | 'messages_usage' | 'estimated';

type PromptScanTokenCounter = (text: string) => Promise<number>;

type PromptScanTokenizationStrategy = {
  countTokens: PromptScanTokenCounter;
  getMode: () => PromptScanTokenizerMode;
  getWarning: () => string | undefined;
};

export class CommandHandler {
  private static readonly ANATOMY_BAR_WIDTH = 28;
  private static readonly MAX_CLAUDE_HISTORY_FILES = 6;
  private static readonly MAX_CLAUDE_HISTORY_ITEMS = 240;
  private static readonly MAX_CLAUDE_HISTORY_CHARS = 32000;
  private static readonly MAX_TOKEN_SCAN_FILES_PER_PROJECT = 24;
  private static readonly MAX_TOKEN_SCAN_FILES_PER_PROJECT_ALL = 5;
  private static readonly MAX_TOKEN_SCAN_FILES_TOTAL = 120;
  private static readonly TOKEN_BAR_WIDTH = 24;
  private static readonly DEFAULT_CONTEXT_WINDOW_TOKENS = 200000;
  private static readonly CONTEXT_HEALTH_WARNING_PERCENT = 70;
  private static readonly CONTEXT_HEALTH_CRITICAL_PERCENT = 85;
  private static readonly AUTOCOMPACT_BUFFER_RATIO = 0.2;
  private static readonly CONTEXT_HEALTH_RECENT_RECORDS = 8;
  private static readonly CONTEXT_HEALTH_MAX_RECORDS_PER_FILE = 3;
  private static readonly SCAN_PROMPT_TIMEOUT_MS = 5 * 60 * 1000;
  private conversationManager: ConversationManager;
  private uiRenderer: UIRenderer;
  private commandRegistry: CommandRegistry;
  private configStore: ConfigStore;
  private onModelSwitch: (args: string[]) => Promise<void>;
  private onProviderSwitch: (args: string[]) => Promise<void>;
  private onCommandDataGenerated: (command: string, data: string) => void;
  private onProjectContextControl: (args: string[]) => Promise<void>;
  private onTrustCurrentPath: () => Promise<void>;
  private onTrustCheckCurrentPath: () => Promise<void>;
  private promptAssetScanner: PromptAssetScanner;
  private skillScanner: SkillScanner;
  private contextNoiseAnalyzer: ContextNoiseAnalyzer;
  private claudeTokenizer: ClaudeTokenizer;

  constructor(
    conversationManager: ConversationManager,
    uiRenderer: UIRenderer,
    commandRegistry: CommandRegistry,
    onModelSwitch: (args: string[]) => Promise<void>,
    onProviderSwitch: (args: string[]) => Promise<void>,
    onCommandDataGenerated: (command: string, data: string) => void,
    onProjectContextControl: (args: string[]) => Promise<void>,
    onTrustCurrentPath: () => Promise<void>,
    onTrustCheckCurrentPath: () => Promise<void>
  ) {
    this.conversationManager = conversationManager;
    this.uiRenderer = uiRenderer;
    this.commandRegistry = commandRegistry;
    this.onModelSwitch = onModelSwitch;
    this.onProviderSwitch = onProviderSwitch;
    this.onCommandDataGenerated = onCommandDataGenerated;
    this.onProjectContextControl = onProjectContextControl;
    this.onTrustCurrentPath = onTrustCurrentPath;
    this.onTrustCheckCurrentPath = onTrustCheckCurrentPath;
    this.promptAssetScanner = new PromptAssetScanner();
    this.skillScanner = new SkillScanner();
    this.contextNoiseAnalyzer = new ContextNoiseAnalyzer();
    this.configStore = new ConfigStore();
    this.claudeTokenizer = new ClaudeTokenizer(this.configStore);
  }

  async handleCommand(input: string): Promise<void> {
    const [command, ...args] = input.slice(1).split(' ');
    const normalizedCommand = command.trim().toLowerCase();

    if (!normalizedCommand) {
      this.showHelp();
      return;
    }

    let resolvedCommand = normalizedCommand;
    if (!this.commandRegistry.getCommand(resolvedCommand)) {
      const prefixMatches = this.commandRegistry.findCommandsByPrefix(resolvedCommand);
      if (prefixMatches.length === 1) {
        resolvedCommand = prefixMatches[0].name;
      } else if (prefixMatches.length > 1) {
        const list = prefixMatches.slice(0, 6).map((cmd) => `/${cmd.name}`).join(', ');
        this.uiRenderer.renderInfo(`Matched multiple commands: ${list}`);
        this.uiRenderer.renderInfo('Continue typing to narrow down the command');
        return;
      }
    }

    switch (resolvedCommand) {
      case 'help':
        this.showHelp();
        break;
      case 'clear':
        this.clearConversation();
        break;
      case 'history':
        this.showHistory();
        break;
      case 'collapse':
        this.collapseMessages(args);
        break;
      case 'expand':
        this.expandMessages(args);
        break;
      case 'exit':
      case 'quit':
        process.exit(0);
        break;
      case 'analyze':
        this.analyzeConversation();
        break;
      case 'export':
        this.exportConversation(args);
        break;
      case 'model':
        await this.onModelSwitch(args);
        break;
      case 'provider':
        await this.onProviderSwitch(args);
        break;
      case 'projectcontext':
      case 'projectctx':
        await this.onProjectContextControl(args);
        break;
      case 'trustpath':
      case 'trust':
        await this.onTrustCurrentPath();
        break;
      case 'trustcheck':
      case 'truststatus':
        await this.onTrustCheckCurrentPath();
        break;
      case 'skills':
      case 'scan_skills':
      case 'skillscan':
        await this.scanSkills(args);
        break;
      case 'scan_prompt':
      case 'scanprompt':
        await this.scanPromptAssets();
        break;
      case 'scan_tokens':
      case 'scantokens':
      case 'tokenscan':
        await this.scanTokenStructures(args);
        break;
      case 'context_health':
      case 'ctxhealth':
      case 'contexthealth':
        await this.checkContextHealth(args);
        break;
      case 'context_noise':
      case 'ctxnoise':
      case 'contextnoise':
        await this.analyzeContextNoise(args);
        break;
      case 'todo_granularity':
      case 'todograin':
      case 'todocontext':
        await this.analyzeTodoGranularity(args);
        break;
      default:
        this.uiRenderer.renderError(`Unknown command: ${command}`);
        this.uiRenderer.renderInfo('Type /help to see available commands');
    }
  }

  private showHelp(): void {
    console.log('');
    console.log(chalk.bold('  Available Commands'));

    const commands = this.commandRegistry.getAllCommands();
    commands.forEach((cmd) => {
      const usage = cmd.usage || `/${cmd.name}`;
      console.log(chalk.dim('  - ') + chalk.cyan(usage) + chalk.dim('  ') + chalk.gray(cmd.description));
    });

    console.log('');
    console.log(chalk.dim('  Tip: type / and press Tab to autocomplete commands'));
    console.log('');
    this.recordCommandData('help', `Listed ${commands.length} commands.`);
  }

  private clearConversation(): void {
    this.conversationManager.clear();
    console.clear();
    this.uiRenderer.renderSuccess('Conversation history cleared');
    this.recordCommandData('clear', 'Conversation history cleared.');
  }

  private showHistory(): void {
    this.uiRenderer.renderAllMessages();
  }

  private collapseMessages(args: string[]): void {
    if (args.length === 0 || args[0] === 'all') {
      this.conversationManager.collapseAll();
      this.uiRenderer.renderSuccess('Collapsed all messages');
      this.uiRenderer.renderAllMessages();
      return;
    }

    const id = args[0];
    if (this.conversationManager.collapse(id)) {
      this.uiRenderer.renderSuccess(`Collapsed message ${id}`);
      this.uiRenderer.renderAllMessages();
    } else {
      this.uiRenderer.renderError(`Message not found: ${id}`);
    }
  }

  private expandMessages(args: string[]): void {
    if (args.length === 0 || args[0] === 'all') {
      this.conversationManager.expandAll();
      this.uiRenderer.renderSuccess('Expanded all messages');
      this.uiRenderer.renderAllMessages();
      return;
    }

    const id = args[0];
    if (this.conversationManager.expand(id)) {
      this.uiRenderer.renderSuccess(`Expanded message ${id}`);
      this.uiRenderer.renderAllMessages();
    } else {
      this.uiRenderer.renderError(`Message not found: ${id}`);
    }
  }

  private analyzeConversation(): void {
    const messages = this.conversationManager.getMessages();
    const total = messages.length;
    const userCount = messages.filter((m) => m.role === 'user').length;
    const assistantCount = messages.filter((m) => m.role === 'assistant').length;
    console.log('');
    console.log(chalk.bold('  Conversation Analysis'));
    console.log(chalk.dim('  - ') + chalk.gray('Total messages: ') + chalk.white(total));
    console.log(chalk.dim('  - ') + chalk.gray('User messages: ') + chalk.white(userCount));
    console.log(chalk.dim('  - ') + chalk.gray('Assistant messages: ') + chalk.white(assistantCount));
    console.log('');
    this.recordCommandData('analyze', `total=${total}, user=${userCount}, assistant=${assistantCount}`);
  }

  private exportConversation(args: string[]): void {
    const filename = args[0] || 'conversation.json';
    this.uiRenderer.renderInfo(`Export is not implemented yet (filename: ${filename})`);
    this.recordCommandData('export', `Export not implemented. Requested filename: ${filename}`);
  }

  private async scanTokenStructures(args: string[]): Promise<void> {
    const spinner = process.stdout.isTTY ? new Spinner() : null;
    if (spinner) {
      spinner.start('Parsing Claude JSONL token structures...');
    } else {
      this.uiRenderer.renderInfo('Parsing Claude JSONL token structures...');
    }

    try {
      const request = this.parseTokenScanRequest(args);
      const target = await this.resolveTokenScanTarget(request);
      if (target.filePaths.length === 0) {
        if (spinner) {
          spinner.stop('Token scan completed');
        } else {
          this.uiRenderer.renderSuccess('Token scan completed');
        }
        this.uiRenderer.renderWarning('No JSONL files found for token scan');
        this.recordCommandData(
          'scan_tokens',
          [`scope=${target.scopeLabel}`, `source=${target.sourceLabel}`, 'jsonlFiles=0'].join('\n')
        );
        return;
      }

      const summary = await this.buildTokenStructureSummary(target.filePaths);
      if (spinner) {
        spinner.stop('Token scan completed');
      } else {
        this.uiRenderer.renderSuccess('Token scan completed');
      }

      this.renderTokenStructureSummary(target, summary);
      const topFields = summary.tokenFields
        .slice(0, 6)
        .map((field) => `${field.name}:${Math.round(field.total)}`)
        .join(', ');
      this.recordCommandData(
        'scan_tokens',
        [
          `scope=${target.scopeLabel}`,
          `source=${target.sourceLabel}`,
          `projectDirs=${target.projectDirs.length}`,
          `jsonlFiles=${summary.totalFiles}`,
          `parsedLines=${summary.parsedLines}`,
          `invalidLines=${summary.invalidLines}`,
          `recordsWithTokens=${summary.recordsWithTokens}`,
          `totalTokenValues=${Math.round(summary.totalTokens)}`,
          `topTokenFields=${topFields || '(none)'}`,
        ].join('\n')
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to scan token structures';
      if (spinner) {
        spinner.fail(message);
      } else {
        this.uiRenderer.renderError(message);
      }
      this.recordCommandData('scan_tokens', `failed: ${message}`);
    }
  }

  private async checkContextHealth(args: string[]): Promise<void> {
    const spinner = process.stdout.isTTY ? new Spinner() : null;
    if (spinner) {
      spinner.start('Evaluating context health...');
    } else {
      this.uiRenderer.renderInfo('Evaluating context health...');
    }

    try {
      const request = this.parseTokenScanRequest(args);
      const target = await this.resolveTokenScanTarget(request);
      if (target.filePaths.length === 0) {
        if (spinner) {
          spinner.stop('Context health check completed');
        } else {
          this.uiRenderer.renderSuccess('Context health check completed');
        }
        this.uiRenderer.renderWarning('No JSONL files found for context health detection');
        this.recordCommandData(
          'context_health',
          [`scope=${target.scopeLabel}`, `source=${target.sourceLabel}`, 'context=missing_jsonl'].join('\n')
        );
        return;
      }

      const recentRecords = await this.findRecentContextUsageRecords(
        target.filePaths,
        CommandHandler.CONTEXT_HEALTH_RECENT_RECORDS
      );
      if (recentRecords.length === 0) {
        if (spinner) {
          spinner.stop('Context health check completed');
        } else {
          this.uiRenderer.renderSuccess('Context health check completed');
        }
        this.uiRenderer.renderWarning('No usage/context fields found in scanned JSONL records');
        this.recordCommandData(
          'context_health',
          [
            `scope=${target.scopeLabel}`,
            `source=${target.sourceLabel}`,
            `jsonlFiles=${target.filePaths.length}`,
            'context=no_usage_fields',
          ].join('\n')
        );
        return;
      }

      const snapshot = this.buildContextHealthSnapshot(recentRecords);
      if (spinner) {
        spinner.stop('Context health check completed');
      } else {
        this.uiRenderer.renderSuccess('Context health check completed');
      }

      this.renderContextHealthSnapshot(target, snapshot);
      this.recordCommandData(
        'context_health',
        [
          `scope=${target.scopeLabel}`,
          `source=${snapshot.source}`,
          `level=${snapshot.level}`,
          `confidence=${snapshot.confidence}`,
          `samples=${snapshot.dataPoints}`,
          `effectivePercent=${snapshot.effectivePercent.toFixed(2)}`,
          `smoothedEffectivePercent=${snapshot.smoothedEffectivePercent.toFixed(2)}`,
          `trendDeltaPercent=${snapshot.trendDeltaPercent === null ? 'n/a' : snapshot.trendDeltaPercent.toFixed(2)}`,
          `rawPercent=${snapshot.rawPercent.toFixed(2)}`,
          `usedTokens=${Math.round(snapshot.usedTokens)}`,
          `windowTokens=${snapshot.contextWindowTokens}`,
          `model=${snapshot.model}`,
          `timestamp=${snapshot.timestampLabel}`,
        ].join('\n')
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to evaluate context health';
      if (spinner) {
        spinner.fail(message);
      } else {
        this.uiRenderer.renderError(message);
      }
      this.recordCommandData('context_health', `failed: ${message}`);
    }
  }

  private async analyzeContextNoise(args: string[]): Promise<void> {
    const spinner = process.stdout.isTTY ? new Spinner() : null;
    if (spinner) {
      spinner.start('Analyzing context noise from Claude sessions...');
    } else {
      this.uiRenderer.renderInfo('Analyzing context noise from Claude sessions...');
    }

    try {
      const request = this.parseTokenScanRequest(args);
      const target = await this.resolveTokenScanTarget(request);
      if (target.filePaths.length === 0) {
        if (spinner) {
          spinner.stop('Context noise analysis completed');
        } else {
          this.uiRenderer.renderSuccess('Context noise analysis completed');
        }
        this.uiRenderer.renderWarning('No Claude session JSONL files found for context noise analysis');
        this.recordCommandData(
          'context_noise',
          [`scope=${target.scopeLabel}`, `source=${target.sourceLabel}`, 'jsonlFiles=0'].join('\n')
        );
        return;
      }

      const analysis = await this.contextNoiseAnalyzer.analyze(
        target.filePaths.map((filePath) => ({
          sessionId: path.basename(filePath, path.extname(filePath)),
          filePath,
        }))
      );
      const coverage = await this.buildPromptCoverageSummary(analysis);

      if (spinner) {
        spinner.stop('Context noise analysis completed');
      } else {
        this.uiRenderer.renderSuccess('Context noise analysis completed');
      }

      this.renderContextNoiseAnalysis(target, analysis, coverage);
      this.recordCommandData(
        'context_noise',
        [
          `scope=${target.scopeLabel}`,
          `source=${target.sourceLabel}`,
          `jsonlFiles=${target.filePaths.length}`,
          `sessionsAnalyzed=${analysis.sessionsAnalyzed}`,
          `sessionsWithSignals=${analysis.sessionsWithSignals}`,
          `events=${analysis.events.length}`,
          `promptAssetsRead=${coverage.readAssets.length}`,
          `promptAssetsUnread=${coverage.unreadAssets.length}`,
          `estimatedTokens=${Math.round(analysis.totalEstimatedTokens)}`,
          `noiseTokens=${Math.round(analysis.totalNoiseTokens)}`,
          `topCategory=${analysis.categories[0]?.label ?? '(none)'}`,
        ].join('\n')
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to analyze context noise';
      if (spinner) {
        spinner.fail(message);
      } else {
        this.uiRenderer.renderError(message);
      }
      this.recordCommandData('context_noise', `failed: ${message}`);
    }
  }

  private async analyzeTodoGranularity(args: string[]): Promise<void> {
    const spinner = process.stdout.isTTY ? new Spinner() : null;
    if (spinner) {
      spinner.start('Analyzing todo granularity against context usage...');
    } else {
      this.uiRenderer.renderInfo('Analyzing todo granularity against context usage...');
    }

    try {
      const request = this.parseTokenScanRequest(args);
      const target = await this.resolveTokenScanTarget(request);
      if (target.filePaths.length === 0) {
        if (spinner) {
          spinner.stop('Todo granularity analysis completed');
        } else {
          this.uiRenderer.renderSuccess('Todo granularity analysis completed');
        }
        this.uiRenderer.renderWarning('No Claude session JSONL files found for todo analysis');
        this.recordCommandData(
          'todo_granularity',
          [`scope=${target.scopeLabel}`, `source=${target.sourceLabel}`, 'jsonlFiles=0'].join('\n')
        );
        return;
      }

      const todosRoot = await this.resolveClaudeDataDirectory('todos');
      const analyzer = new TodoGranularityAnalyzer({ todosRoot });
      const analysis = await analyzer.analyze(
        target.filePaths.map((filePath) => ({
          sessionId: path.basename(filePath, path.extname(filePath)),
          filePath,
        }))
      );

      if (spinner) {
        spinner.stop('Todo granularity analysis completed');
      } else {
        this.uiRenderer.renderSuccess('Todo granularity analysis completed');
      }

      this.renderTodoGranularityAnalysis(target, analysis);
      this.recordCommandData(
        'todo_granularity',
        [
          `scope=${target.scopeLabel}`,
          `source=${target.sourceLabel}`,
          `jsonlFiles=${target.filePaths.length}`,
          `sessionsScanned=${analysis.sessionsScanned}`,
          `sessionsWithTodos=${analysis.sessionsWithTodos}`,
          `todoFilesFound=${analysis.todoFilesFound}`,
          `todos=${analysis.items.length}`,
          `todosWithContext=${analysis.todosWithContext}`,
          `pearsonR=${analysis.pearsonR === null ? 'n/a' : analysis.pearsonR.toFixed(3)}`,
          `correlation=${analysis.correlationLabel}`,
          `suggestions=${analysis.suggestions.length}`,
        ].join('\n')
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to analyze todo granularity';
      if (spinner) {
        spinner.fail(message);
      } else {
        this.uiRenderer.renderError(message);
      }
      this.recordCommandData('todo_granularity', `failed: ${message}`);
    }
  }

  private renderTodoGranularityAnalysis(target: TokenScanTarget, analysis: TodoGranularityAnalysis): void {
    const headerLines = [
      `Scope: ${target.scopeLabel}`,
      `Source: ${target.sourceLabel}`,
      `Sessions scanned: ${analysis.sessionsScanned}`,
      `Sessions with todos: ${analysis.sessionsWithTodos}`,
      `Todo files found: ${analysis.todoFilesFound}`,
      `Snapshot fallback sessions: ${analysis.sessionsUsingSnapshotFallback}`,
      `Todos analyzed: ${analysis.items.length}`,
      `Todos with context usage: ${analysis.todosWithContext}`,
    ];

    console.log(
      boxen(headerLines.join('\n'), {
        borderStyle: 'round',
        borderColor: 'gray',
        title: ' Todo Granularity ',
        titleAlignment: 'left',
        padding: { top: 0, right: 1, bottom: 0, left: 1 },
      })
    );

    console.log('');
    console.log(chalk.bold('  Granularity Distribution'));
    if (analysis.items.length === 0) {
      console.log(chalk.dim('  - (no todo items found)'));
    } else {
      const maxCount = analysis.buckets.reduce((max, bucket) => Math.max(max, bucket.count), 0);
      analysis.buckets.forEach((bucket) => {
        const bar = this.renderTokenBar(bucket.count, Math.max(1, maxCount), chalk.cyan);
        const count = `${bucket.count}`.padStart(3, ' ');
        const share = `${Math.round(bucket.share * 100)}%`.padStart(4, ' ');
        console.log(`  ${bar} Score ${bucket.score}  ${count}  ${chalk.dim(share)}`);
      });
    }

    console.log('');
    console.log(chalk.bold('  Correlation'));
    if (analysis.pearsonR === null) {
      console.log(chalk.dim('  - Not enough samples to compute a Pearson correlation.'));
    } else {
      const correlationColor = analysis.pearsonR >= 0.4 ? chalk.yellow : analysis.pearsonR <= -0.4 ? chalk.green : chalk.gray;
      console.log(
        `  Pearson R = ${correlationColor(analysis.pearsonR.toFixed(2))}  ${chalk.dim(`(${analysis.correlationLabel})`)}`
      );
      if (analysis.pearsonR > 0.2) {
        console.log(chalk.dim('  - Coarser todos tend to correlate with higher average context usage.'));
      } else if (analysis.pearsonR < -0.2) {
        console.log(chalk.dim('  - Finer-grained todos are carrying more context than expected, so the naming and split strategy may need review.'));
      } else {
        console.log(chalk.dim('  - Granularity and context usage do not show a clear monotonic relationship right now.'));
      }
    }

    console.log('');
    console.log(chalk.bold('  Outcome By Score'));
    analysis.buckets.forEach((bucket) => {
      const truncation = bucket.truncationRate === null ? 'n/a' : `${(bucket.truncationRate * 100).toFixed(0)}%`;
      const completion = bucket.completionRate === null ? 'n/a' : `${(bucket.completionRate * 100).toFixed(0)}%`;
      const stuck = bucket.stuckRate === null ? 'n/a' : `${(bucket.stuckRate * 100).toFixed(0)}%`;
      console.log(
        `  Score ${bucket.score}  ${chalk.dim('trunc')} ${truncation.padStart(4, ' ')}  ${chalk.dim(
          'done'
        )} ${completion.padStart(4, ' ')}  ${chalk.dim('stuck')} ${stuck.padStart(4, ' ')}`
      );
    });

    console.log('');
    console.log(chalk.bold('  Split Suggestions'));
    if (analysis.suggestions.length === 0) {
      console.log(chalk.dim('  - No todo currently stands out as an obvious split candidate.'));
    } else {
      analysis.suggestions.forEach((suggestion, index) => {
        const tokenText =
          suggestion.contextTokens === null ? chalk.dim('context n/a') : chalk.dim(`${this.formatTokenNumber(suggestion.contextTokens)} tok`);
        console.log(
          `  ${index + 1}. ${chalk.white(suggestion.content)} ${chalk.dim(`[score ${suggestion.granularityScore}]`)} ${tokenText}`
        );
        console.log(`     ${chalk.dim('reason:')} ${suggestion.reason}`);
        console.log(`     ${chalk.dim('split:')} ${suggestion.splitHint}`);
      });
    }

    if (analysis.warnings.length > 0) {
      console.log('');
      console.log(chalk.bold('  Notes'));
      analysis.warnings.forEach((warning) => {
        console.log(chalk.dim('  - ') + chalk.yellow(warning));
      });
    }
  }

  private buildSuggestionsFromLlmPrompt(
    promptScan: any,
    tokenScan: any,
    contextHealth: any
  ): string {
    return [
      'You are a senior prompt-engineering and context-optimization advisor reviewing a Claude / Agent workflow.',
      'Base your judgment strictly on the scan summaries below. Do not invent facts. If evidence is insufficient, say so explicitly.',
      'Goal: combine the outputs of /scan_prompt, /scan_tokens, and /context_health, then identify what in the current project most needs to be changed or tuned.',
      '',
      'Respond in English using this structure, and keep the conclusions concrete and actionable:',
      '1. Overall assessment: 2-4 sentences summarizing the current state and the main risks.',
      '2. High-priority adjustments: 3-5 items, each with [Problem] [Evidence] [Recommended action].',
      '3. Suggested change list: group recommendations under [Prompt / Rules] [Docs / Reference] [Context / Token].',
      '4. Missing information or uncertainty: if any area lacks evidence, explain what additional data is needed.',
      '',
      '[scan_prompt summary]',
      promptScan.commandData,
      '',
      '[scan_tokens summary]',
      tokenScan.commandData,
      '',
      '[context_health summary]',
      contextHealth.commandData,
    ].join('\n');
  }

  private renderSuggestionsFromLlm(reply: { content: string }): void {
    console.log(
      boxen(reply.content.trim() || '(empty response)', {
        borderStyle: 'round',
        borderColor: 'magenta',
        title: ' LLM Suggestions ',
        titleAlignment: 'left',
        padding: { top: 0, right: 1, bottom: 0, left: 1 },
      })
    );
  }

  private async findRecentContextUsageRecords(filePaths: string[], maxRecords: number): Promise<ContextUsageRecord[]> {
    if (maxRecords <= 0) {
      return [];
    }

    const collected: ContextUsageRecord[] = [];
    for (const filePath of filePaths) {
      let raw = '';
      let fileTimestampMs = 0;
      try {
        raw = await fs.readFile(filePath, 'utf8');
        const stat = await fs.stat(filePath);
        fileTimestampMs = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0;
      } catch {
        continue;
      }

      const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
      let perFileCount = 0;
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (perFileCount >= CommandHandler.CONTEXT_HEALTH_MAX_RECORDS_PER_FILE) {
          break;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(lines[i]) as unknown;
        } catch {
          continue;
        }

        const candidate = this.extractContextUsageRecord(parsed, filePath, fileTimestampMs);
        if (!candidate) {
          continue;
        }

        collected.push(candidate);
        perFileCount += 1;
      }
    }

    return collected
      .sort((a, b) => b.timestampMs - a.timestampMs)
      .slice(0, maxRecords);
  }

  private extractContextUsageRecord(payload: unknown, filePath: string, fileTimestampMs: number): ContextUsageRecord | null {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const usageObject =
      this.getObjectAtPath(payload, ['message', 'usage']) ??
      this.getObjectAtPath(payload, ['usage']) ??
      this.getObjectAtPath(payload, ['response', 'usage']);

    const inputTokens = this.getNumberAtPaths(usageObject, [['input_tokens'], ['inputTokens']]) ?? 0;
    const cacheCreationTokens =
      this.getNumberAtPaths(usageObject, [['cache_creation_input_tokens'], ['cacheCreationInputTokens']]) ?? 0;
    const cacheReadTokens =
      this.getNumberAtPaths(usageObject, [['cache_read_input_tokens'], ['cacheReadInputTokens']]) ?? 0;

    const contextUsedPercent =
      this.getNumberAtPaths(payload, [
        ['stdin', 'context_window', 'used_percentage'],
        ['context_window', 'used_percentage'],
        ['contextWindow', 'usedPercentage'],
      ]) ?? null;

    const contextWindowTokens =
      this.getNumberAtPaths(payload, [
        ['stdin', 'context_window', 'max_tokens'],
        ['stdin', 'context_window', 'context_window_size'],
        ['context_window', 'max_tokens'],
        ['context_window', 'context_window_size'],
        ['contextWindow', 'maxTokens'],
        ['contextWindow', 'contextWindowSize'],
      ]) ?? null;

    const hasUsage = inputTokens > 0 || cacheCreationTokens > 0 || cacheReadTokens > 0;
    const hasContextPercent = contextUsedPercent !== null;
    if (!hasUsage && !hasContextPercent) {
      return null;
    }

    const timestampMsFromPayload = this.extractTokenTimestampMs(payload);
    const timestampMs = timestampMsFromPayload > 0 ? timestampMsFromPayload : fileTimestampMs;
    const timestampLabel = timestampMs > 0 ? new Date(timestampMs).toLocaleString() : 'unknown';

    const model =
      this.getStringAtPaths(payload, [['message', 'model'], ['model'], ['response', 'model']]) ??
      this.getStringAtPaths(payload, [['version']]) ??
      'unknown';

    return {
      timestampMs,
      timestampLabel,
      filePath,
      model,
      contextUsedPercent: contextUsedPercent === null ? null : Math.max(0, Math.min(100, contextUsedPercent)),
      contextWindowTokens: contextWindowTokens === null ? null : Math.max(1, Math.round(contextWindowTokens)),
      inputTokens,
      cacheCreationTokens,
      cacheReadTokens,
    };
  }

  private buildContextHealthSnapshot(records: ContextUsageRecord[]): ContextHealthSnapshot {
    const latestRecord = records[0];
    const latestMetrics = this.calculateContextUsageMetrics(latestRecord);
    const metricsWindow = records.slice(0, 3).map((record) => this.calculateContextUsageMetrics(record));
    const smoothedEffectivePercent =
      metricsWindow.length > 0
        ? metricsWindow.reduce((sum, item) => sum + item.effectivePercent, 0) / metricsWindow.length
        : latestMetrics.effectivePercent;
    const trendDeltaPercent =
      records.length > 1
        ? latestMetrics.effectivePercent - this.calculateContextUsageMetrics(records[1]).effectivePercent
        : null;

    // Use both immediate and smoothed values to reduce one-off spikes.
    const levelSignal = Math.max(latestMetrics.effectivePercent, smoothedEffectivePercent);
    const levelOutcome = this.resolveContextHealthLevel(levelSignal);
    const confidenceOutcome = this.resolveContextHealthConfidence(latestRecord, latestMetrics, records.length);

    return {
      level: levelOutcome.level,
      levelReason: levelOutcome.levelReason,
      confidence: confidenceOutcome.confidence,
      confidenceReason: confidenceOutcome.reason,
      source: latestMetrics.source,
      model: latestRecord.model,
      rawPercent: latestMetrics.rawPercent,
      effectivePercent: latestMetrics.effectivePercent,
      smoothedEffectivePercent,
      trendDeltaPercent,
      dataPoints: records.length,
      usedTokens: latestMetrics.usedTokens,
      contextWindowTokens: latestMetrics.contextWindowTokens,
      usableContextTokens: latestMetrics.usableContextTokens,
      autocompactBufferTokens: latestMetrics.autocompactBufferTokens,
      inputTokens: latestRecord.inputTokens,
      cacheCreationTokens: latestRecord.cacheCreationTokens,
      cacheReadTokens: latestRecord.cacheReadTokens,
      timestampLabel: latestRecord.timestampLabel,
      filePath: latestRecord.filePath,
    };
  }

  private calculateContextUsageMetrics(record: ContextUsageRecord): {
    source: 'native' | 'calculated';
    rawPercent: number;
    effectivePercent: number;
    usedTokens: number;
    contextWindowTokens: number;
    usableContextTokens: number;
    autocompactBufferTokens: number;
  } {
    const estimatedWindow = this.estimateContextWindowTokens(record.model);
    const contextWindowTokens = record.contextWindowTokens ?? estimatedWindow;
    const autocompactBufferTokens = Math.round(contextWindowTokens * CommandHandler.AUTOCOMPACT_BUFFER_RATIO);
    const usableContextTokens = Math.max(1, contextWindowTokens - autocompactBufferTokens);

    const usageTokens = Math.max(0, record.inputTokens + record.cacheCreationTokens + record.cacheReadTokens);
    const rawPercentFromUsage = contextWindowTokens > 0 ? (usageTokens / contextWindowTokens) * 100 : 0;
    const rawPercentFromNative =
      record.contextUsedPercent !== null ? Math.max(0, Math.min(100, record.contextUsedPercent)) : null;
    const rawPercent = rawPercentFromNative ?? rawPercentFromUsage;

    const usedTokensFromNative =
      rawPercentFromNative !== null ? Math.round((rawPercentFromNative / 100) * contextWindowTokens) : 0;
    let usedTokens =
      rawPercentFromNative !== null
        ? Math.max(usedTokensFromNative, usageTokens)
        : usageTokens;

    if (usedTokens <= 0 && rawPercent > 0) {
      usedTokens = Math.round((rawPercent / 100) * contextWindowTokens);
    }

    const effectivePercent = Math.max(0, Math.min(100, (usedTokens / usableContextTokens) * 100));
    return {
      source: rawPercentFromNative !== null ? 'native' : 'calculated',
      rawPercent,
      effectivePercent,
      usedTokens,
      contextWindowTokens,
      usableContextTokens,
      autocompactBufferTokens,
    };
  }

  private resolveContextHealthConfidence(
    latestRecord: ContextUsageRecord,
    latestMetrics: { source: 'native' | 'calculated'; contextWindowTokens: number },
    sampleCount: number
  ): { confidence: ContextHealthConfidence; reason: string } {
    let score = 0;
    const reasons: string[] = [];

    if (latestMetrics.source === 'native') {
      score += 2;
      reasons.push('native context usage available');
    } else {
      reasons.push('derived from usage tokens only');
    }

    if (latestRecord.contextWindowTokens !== null) {
      score += 1;
      reasons.push('explicit context window in record');
    } else {
      reasons.push(`context window estimated (${this.formatTokenNumber(latestMetrics.contextWindowTokens)} tokens)`);
    }

    if (sampleCount >= 3) {
      score += 1;
      reasons.push(`trend based on ${sampleCount} samples`);
    } else if (sampleCount === 2) {
      score += 0;
      reasons.push('limited trend history');
    } else {
      score -= 1;
      reasons.push('single-sample snapshot');
    }

    if (latestRecord.model && latestRecord.model !== 'unknown') {
      score += 1;
    } else {
      score -= 1;
      reasons.push('model not identified');
    }

    const nowMs = Date.now();
    const ageMs = Math.max(0, nowMs - latestRecord.timestampMs);
    const ageHours = ageMs / (1000 * 60 * 60);
    if (ageHours > 24) {
      score -= 1;
      reasons.push(`latest sample is stale (${ageHours.toFixed(1)}h old)`);
    }

    const confidence: ContextHealthConfidence = score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low';
    return { confidence, reason: reasons.join('; ') };
  }

  private resolveContextHealthLevel(effectivePercent: number): { level: ContextHealthLevel; levelReason: string } {
    if (!Number.isFinite(effectivePercent) || effectivePercent < 0) {
      return { level: 'unknown', levelReason: 'invalid context metrics' };
    }

    if (effectivePercent >= CommandHandler.CONTEXT_HEALTH_CRITICAL_PERCENT) {
      return { level: 'critical', levelReason: 'close to context saturation' };
    }

    if (effectivePercent >= CommandHandler.CONTEXT_HEALTH_WARNING_PERCENT) {
      return { level: 'elevated', levelReason: 'context pressure is increasing' };
    }

    return { level: 'healthy', levelReason: 'context usage is in a safe range' };
  }

  private renderContextHealthSnapshot(target: TokenScanTarget, snapshot: ContextHealthSnapshot): void {
    const levelText =
      snapshot.level === 'critical'
        ? chalk.red('CRITICAL')
        : snapshot.level === 'elevated'
        ? chalk.yellow('ELEVATED')
        : snapshot.level === 'healthy'
        ? chalk.green('HEALTHY')
        : chalk.gray('UNKNOWN');
    const confidenceText =
      snapshot.confidence === 'high'
        ? chalk.green('HIGH')
        : snapshot.confidence === 'medium'
        ? chalk.yellow('MEDIUM')
        : chalk.red('LOW');

    const rawBar = this.renderPercentBar(snapshot.rawPercent, chalk.blue);
    const effectiveBar = this.renderPercentBar(snapshot.effectivePercent, this.colorizeLevel(snapshot.level));
    const smoothedBar = this.renderPercentBar(snapshot.smoothedEffectivePercent, this.colorizeLevel(snapshot.level));
    const fileLabel = this.truncateBlockName(snapshot.filePath, 88);
    const trendText =
      snapshot.trendDeltaPercent === null
        ? chalk.dim('n/a (need >=2 samples)')
        : snapshot.trendDeltaPercent > 0
        ? chalk.red(`+${snapshot.trendDeltaPercent.toFixed(1)}% vs previous`)
        : snapshot.trendDeltaPercent < 0
        ? chalk.green(`${snapshot.trendDeltaPercent.toFixed(1)}% vs previous`)
        : chalk.dim('0.0% vs previous');

    const lines: string[] = [
      `Scope: ${target.scopeLabel}`,
      `Status: ${levelText} (${snapshot.levelReason})`,
      `Confidence: ${confidenceText} (${snapshot.confidenceReason})`,
      `Samples: ${snapshot.dataPoints}`,
      `Model: ${snapshot.model}`,
      `Source: ${snapshot.source === 'native' ? 'native context_window.used_percentage' : 'calculated from usage tokens'}`,
      `Observed at: ${snapshot.timestampLabel}`,
      `Raw usage:      ${rawBar} ${snapshot.rawPercent.toFixed(1)}%`,
      `Buffered usage: ${effectiveBar} ${snapshot.effectivePercent.toFixed(1)}%`,
      `Smoothed(3):    ${smoothedBar} ${snapshot.smoothedEffectivePercent.toFixed(1)}%`,
      `Trend: ${trendText}`,
      `Tokens: ${this.formatTokenNumber(snapshot.usedTokens)} used / ${this.formatTokenNumber(snapshot.contextWindowTokens)} window`,
      `Buffer reserve: ${this.formatTokenNumber(snapshot.autocompactBufferTokens)} tokens (${Math.round(
        CommandHandler.AUTOCOMPACT_BUFFER_RATIO * 100
      )}%)`,
      `Breakdown: input ${this.formatTokenNumber(snapshot.inputTokens)}, cache_create ${this.formatTokenNumber(
        snapshot.cacheCreationTokens
      )}, cache_read ${this.formatTokenNumber(snapshot.cacheReadTokens)}`,
      `Record file: ${fileLabel}`,
    ];

    console.log(
      boxen(lines.join('\n'), {
        borderStyle: 'round',
        borderColor: snapshot.level === 'critical' ? 'red' : snapshot.level === 'elevated' ? 'yellow' : 'gray',
        title: ' Context Health ',
        titleAlignment: 'left',
        padding: { top: 0, right: 1, bottom: 0, left: 1 },
      })
    );

    const suggestions = this.getContextHealthSuggestions(snapshot.level, snapshot.confidence);
    if (suggestions.length > 0) {
      console.log('');
      console.log(chalk.bold('  Recommendations'));
      suggestions.forEach((suggestion) => {
        console.log(chalk.dim('  - ') + suggestion);
      });
    }
  }

  private async buildPromptCoverageSummary(analysis: ContextNoiseAnalysis): Promise<PromptCoverageSummary> {
    const rootPath = path.resolve(process.cwd());
    const promptScan = await this.promptAssetScanner.scan(rootPath);
    const skillScan = await this.skillScanner.scan(rootPath);

    const assetMap = new Map<string, PromptCoverageItem>();
    for (const file of promptScan.files) {
      const fullPath = path.resolve(rootPath, file.relativePath);
      const relativePath = this.normalizeRelativePath(path.relative(rootPath, fullPath));
      const content = await this.safeReadText(fullPath);
      assetMap.set(relativePath.toLowerCase(), {
        relativePath,
        fullPath,
        kind: 'prompt',
        label: file.categories.join(', '),
        tokenCount: file.tokenCount,
        summary: this.summarizeAssetText(content, relativePath),
        headings: this.extractMarkdownHeadings(content).slice(0, 4),
        read: false,
        readTokens: 0,
        wasReferencedLater: false,
      });
    }

    for (const skill of skillScan.skills) {
      const fullPath = path.resolve(rootPath, skill.skillFileRelativePath);
      const relativePath = this.normalizeRelativePath(path.relative(rootPath, fullPath));
      if (assetMap.has(relativePath.toLowerCase())) {
        continue;
      }
      const content = await this.safeReadText(fullPath);
      assetMap.set(relativePath.toLowerCase(), {
        relativePath,
        fullPath,
        kind: 'skill',
        label: 'skill',
        tokenCount: skill.instructionTokenEstimate,
        summary: skill.purpose || this.summarizeAssetText(content, relativePath),
        headings: skill.headings.slice(0, 4),
        read: false,
        readTokens: 0,
        wasReferencedLater: false,
      });
    }

    const bestReadByAsset = new Map<string, ContextNoiseReadRecord>();
    for (const record of analysis.readRecords) {
      const candidatePaths = [
        path.resolve(rootPath, record.path),
        record.cwd ? path.resolve(record.cwd, record.path) : '',
        path.resolve(record.path),
      ]
        .filter(Boolean)
        .map((candidate) => this.normalizeRelativePath(path.relative(rootPath, candidate)).toLowerCase())
        .filter((candidate) => candidate && !candidate.startsWith('..'));

      const matchedKey = candidatePaths.find((candidate) => assetMap.has(candidate));
      if (!matchedKey) {
        continue;
      }
      const asset = assetMap.get(matchedKey);
      if (!asset) {
        continue;
      }
      const previous = bestReadByAsset.get(matchedKey);
      if (!previous || record.tokenCount > previous.tokenCount) {
        bestReadByAsset.set(matchedKey, record);
      }
    }

    bestReadByAsset.forEach((record, relativePathKey) => {
      const asset = assetMap.get(relativePathKey);
      if (!asset) {
        return;
      }
      asset.read = true;
      asset.readTokens = record.tokenCount;
      asset.wasReferencedLater = record.wasReferencedLater;
      const extracted = this.summarizeToolReadContent(record.resultContent, asset.relativePath);
      if (extracted.summary) {
        asset.summary = extracted.summary;
      }
      if (extracted.headings.length > 0) {
        asset.headings = extracted.headings.slice(0, 4);
      }
    });

    const assets = Array.from(assetMap.values());
    const readAssets = assets
      .filter((asset) => asset.read)
      .sort((a, b) => b.readTokens - a.readTokens || a.relativePath.localeCompare(b.relativePath));
    const unreadAssets = assets
      .filter((asset) => !asset.read)
      .sort((a, b) => b.tokenCount - a.tokenCount || a.relativePath.localeCompare(b.relativePath));
    const highValueAssets = readAssets.filter((asset) => asset.wasReferencedLater);
    const signals: PromptCoverageSignal[] = [
      ...readAssets
        .filter((asset) => !asset.wasReferencedLater)
        .map((asset) => ({
          kind: 'read_only' as const,
          severity: asset.readTokens >= 1200 ? 'high' as const : asset.readTokens >= 500 ? 'medium' as const : 'low' as const,
          tokenImpact: asset.readTokens,
          reason: 'This asset was loaded into context but showed no clear downstream reuse.',
          asset,
        })),
      ...unreadAssets
        .filter((asset) => asset.tokenCount >= 500)
        .slice(0, 8)
        .map((asset) => ({
          kind: 'unused' as const,
          severity: asset.tokenCount >= 1200 ? 'medium' as const : 'low' as const,
          tokenImpact: asset.tokenCount,
          reason: 'This larger prompt or skill asset exists in the repo but was never touched in the scanned sessions.',
          asset,
        })),
      ...highValueAssets.slice(0, 6).map((asset) => ({
        kind: 'high_value' as const,
        severity: 'low' as const,
        tokenImpact: asset.readTokens,
        reason: 'This asset continued to influence later tool inputs or reasoning and appears to be high-value context.',
        asset,
      })),
    ]
      .sort((a, b) => b.tokenImpact - a.tokenImpact || a.asset.relativePath.localeCompare(b.asset.relativePath))
      .slice(0, 12);

    return {
      scannedAssets: assets.length,
      matchedReadCount: bestReadByAsset.size,
      scannedPromptFiles: promptScan.files.length,
      scannedSkills: skillScan.skills.length,
      readAssets,
      unreadAssets,
      highValueAssets,
      promptNoiseTokens: readAssets
        .filter((asset) => !asset.wasReferencedLater)
        .reduce((sum, asset) => sum + asset.readTokens, 0),
      signals,
    };
  }

  private renderContextNoiseAnalysis(target: TokenScanTarget, analysis: ContextNoiseAnalysis, coverage: PromptCoverageSummary): void {
    const noisyShare = analysis.totalEstimatedTokens > 0 ? analysis.totalNoiseTokens / analysis.totalEstimatedTokens : 0;
    const primarySession = analysis.primarySession;
    const noiseTokenLabel =
      noisyShare >= 0.3
        ? chalk.red(`${this.formatTokenNumber(analysis.totalNoiseTokens)} tok (${Math.round(noisyShare * 100)}%)`)
        : noisyShare >= 0.15
        ? chalk.yellow(`${this.formatTokenNumber(analysis.totalNoiseTokens)} tok (${Math.round(noisyShare * 100)}%)`)
        : chalk.green(`${this.formatTokenNumber(analysis.totalNoiseTokens)} tok (${Math.round(noisyShare * 100)}%)`);

    const metaLines: string[] = [
      `Scope: ${target.scopeLabel} (${target.sourceLabel})`,
      `Session: ${
        primarySession
          ? `${primarySession.sessionId} | ${primarySession.startTime} -> ${primarySession.endTime}`
          : 'n/a'
      }`,
      `Total tokens: ${this.formatTokenNumber(analysis.totalEstimatedTokens)} tok`,
      `Noise tokens: ${noiseTokenLabel}`,
      `Tool calls: ${this.formatTokenNumber(analysis.totalToolCalls)}`,
      `Duplicate calls: ${this.formatTokenNumber(analysis.duplicateCalls)}`,
      `Session file: ${primarySession ? this.truncateBlockName(primarySession.filePath, 92) : 'n/a'}`,
    ];

    console.log(
      boxen(metaLines.join('\n'), {
        borderStyle: 'round',
        borderColor: noisyShare >= 0.3 ? 'red' : noisyShare >= 0.15 ? 'yellow' : 'green',
        title: ' Context Noise ',
        titleAlignment: 'left',
        padding: { top: 0, right: 1, bottom: 0, left: 1 },
      })
    );

    console.log('');
    console.log(chalk.bold('  Noise Categories'));
    analysis.categories.forEach((category) => {
      const colorize = this.getNoiseCategoryColor(category.key);
      const bar = this.renderPercentBar(Math.min(100, category.shareOfThreshold * 100), colorize);
      const header = `${category.tool} | ${category.label}`.padEnd(22, ' ');
      const countText = `${category.callCount}x`.padStart(5, ' ');
      const tokenText = `${this.formatTokenNumber(category.tokens)} tok`.padStart(12, ' ');
      console.log(`  ${colorize(header)} ${bar} ${countText} ${tokenText}`);
    });

    console.log('');
    console.log(chalk.bold(`  Recent Noise Events (${Math.min(8, analysis.events.length)})`));
    if (analysis.events.length === 0) {
      console.log(chalk.green('  - No obvious noise events were detected in the scanned sessions.'));
    } else {
      analysis.events.slice(0, 8).forEach((event) => {
        const tagText = this.renderNoiseTag(event.tag);
        const target = this.truncateBlockName(event.target || '(unknown target)', 48).padEnd(48, ' ');
        const tokenText = `${this.formatTokenNumber(event.tokens)} tok`.padStart(10, ' ');
        console.log(`  ${chalk.dim(`[${event.timestampLabel}]`)} ${event.tool.padEnd(4, ' ')} ${target} ${tokenText}  ${tagText}`);
        console.log(chalk.dim(`      ${event.reason}`));
      });
    }

    console.log('');
    console.log(chalk.bold('  File Read Hotspot'));
    if (analysis.fileHotspots.length === 0) {
      console.log(chalk.dim('  - No Read tool activity was detected.'));
    } else {
      analysis.fileHotspots.slice(0, 8).forEach((hotspot) => {
        const heat =
          hotspot.heat === 'high'
            ? chalk.red('hot')
            : hotspot.heat === 'medium'
            ? chalk.yellow('warm')
            : chalk.gray('cool');
        console.log(
          `  ${this.truncateBlockName(hotspot.path, 48).padEnd(48, ' ')} ${String(hotspot.totalReads).padStart(4, ' ')} reads ${String(
            hotspot.uniqueReads
          ).padStart(4, ' ')} unique ${String(hotspot.dupReads).padStart(4, ' ')} dup ${this.formatTokenNumber(
            hotspot.tokensConsumed
          ).padStart(8, ' ')} tok  ${heat}`
        );
      });
    }

    console.log('');
    console.log(chalk.bold('  Prompt Asset Signals'));
    console.log(
      chalk.dim(
        `  scanned prompt files ${coverage.scannedPromptFiles}, scanned skills ${coverage.scannedSkills}, matched reads ${coverage.matchedReadCount}`
      )
    );
    if (coverage.signals.length === 0) {
      console.log(chalk.dim('  - No prompt-asset signals were extracted.'));
    } else {
      coverage.signals.slice(0, 8).forEach((signal) => {
        const tone =
          signal.kind === 'high_value'
            ? chalk.green
            : signal.kind === 'read_only'
            ? chalk.yellow
            : chalk.gray;
        const label =
          signal.kind === 'high_value'
            ? 'used'
            : signal.kind === 'read_only'
            ? 'read-only'
            : 'unused';
        const asset = signal.asset;
        const tokenCount = signal.kind === 'unused' ? asset.tokenCount : asset.readTokens;
        console.log(
          `  ${tone(label.padEnd(9, ' '))} ${this.truncateBlockName(asset.relativePath, 46).padEnd(46, ' ')} ${this.formatTokenNumber(
            tokenCount
          ).padStart(8, ' ')} tok`
        );
        console.log(chalk.dim(`      ${signal.reason}`));
      });
    }

    console.log('');
    const footerText =
      noisyShare >= 0.3
        ? chalk.yellow(`  ! high noise | ${this.formatTokenNumber(analysis.totalNoiseTokens)} tok recoverable`)
        : chalk.green('  OK noise within acceptable range');
    console.log(footerText);

    const recommendations = this.buildContextNoiseRecommendations(analysis, coverage);
    if (recommendations.length > 0) {
      console.log('');
      console.log(chalk.bold('  Recommendations'));
      recommendations.forEach((recommendation) => {
        console.log(chalk.dim('  - ') + recommendation);
      });
    }

    if (analysis.warnings.length > 0) {
      console.log('');
      console.log(chalk.bold('  Warnings'));
      analysis.warnings.forEach((warning) => {
        console.log(chalk.dim('  - ') + chalk.yellow(warning));
      });
    }
  }

  private buildContextNoiseRecommendations(analysis: ContextNoiseAnalysis, coverage: PromptCoverageSummary): string[] {
    const recommendations: string[] = [];
    const topCategory = analysis.categories[0];
    const topEvent = analysis.events[0];
    const noisyShare = analysis.totalEstimatedTokens > 0 ? analysis.totalNoiseTokens / analysis.totalEstimatedTokens : 0;

    if (noisyShare >= 0.3) {
      recommendations.push(chalk.red('Recoverable noise is already high. Trim the biggest duplicate reads and repeated commands before the next long turn.'));
    } else if (noisyShare >= 0.15) {
      recommendations.push(chalk.yellow('Context quality is starting to drift. Prune repeated scans and read-only assets first.'));
    } else {
      recommendations.push(chalk.green('Noise is still manageable. Focus on preventing repeat reads, repeated Bash runs, and empty searches.'));
    }

    if (topCategory?.key === 'read_dup' || topCategory?.key === 'ctx_stale') {
      recommendations.push(chalk.yellow('Read-related noise dominates. Add a "summarize first, then read line ranges" rule to CLAUDE.md and reuse the latest valid read.'));
    } else if (topCategory?.key === 'bash_dup') {
      recommendations.push(chalk.yellow('Repeated Bash runs are expensive. Check whether the same command output is already in context before rerunning it.'));
    } else if (topCategory?.key === 'grep_miss') {
      recommendations.push(chalk.yellow('Grep misses are frequent. Confirm the path scope first, then narrow the pattern to avoid repeated empty searches.'));
    } else if (topCategory?.key === 'ls_redundant') {
      recommendations.push(chalk.yellow('Directory scans dominate. Start from narrower target folders instead of broad scans from the project root.'));
    }

    if (topEvent?.tag === 'bloat') {
      recommendations.push(chalk.red('Large but unused context is showing up in recent events. Replace whole-file reads or big outputs with summaries and excerpts.'));
    }

    if (coverage.readAssets.length === 0 && coverage.scannedAssets > 0) {
      recommendations.push(chalk.yellow('No prompt or skill assets were explicitly read. If they should shape behavior, make the retrieval step explicit.'));
    }
    if (coverage.promptNoiseTokens > 0) {
      recommendations.push(chalk.yellow('Some prompt assets were read but never reused. Separate always-on rules from on-demand assets.'));
    }
    if (coverage.unreadAssets.length > 0) {
      recommendations.push(chalk.yellow('Large unread assets still exist in the repo. Decide which ones belong in default context and which should stay outside the window.'));
    }

    return Array.from(new Set(recommendations)).slice(0, 4);
  }

  private async safeReadText(filePath: string): Promise<string> {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch {
      return '';
    }
  }

  private summarizeToolReadContent(content: string, filePath: string): { summary: string; headings: string[] } {
    const cleaned = content
      .replace(/^\s*\d+\s*(?:[:>|-]\s*)?/gm, '')
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
      .replace(/\r\n/g, '\n')
      .trim();
    return {
      summary: this.summarizeAssetText(cleaned, filePath),
      headings: this.extractMarkdownHeadings(cleaned),
    };
  }

  private summarizeAssetText(content: string, filePath: string): string {
    const cleaned = content.replace(/\r\n/g, '\n').trim();
    if (!cleaned) {
      return '';
    }

    const headings = this.extractMarkdownHeadings(cleaned);
    if (headings.length > 0) {
      const firstParagraph = this.extractFirstMeaningfulParagraph(cleaned);
      return firstParagraph ? `${headings[0]} - ${firstParagraph}` : headings[0];
    }

    const firstParagraph = this.extractFirstMeaningfulParagraph(cleaned);
    if (firstParagraph) {
      return firstParagraph;
    }

    const fileName = path.basename(filePath);
    return `Read ${fileName}`;
  }

  private extractMarkdownHeadings(content: string): string[] {
    const headings: string[] = [];
    const seen = new Set<string>();
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*#{1,6}\s+(.+?)\s*$/);
      if (!match) {
        continue;
      }
      const heading = match[1].replace(/[`*_]/g, '').trim();
      if (!heading || seen.has(heading)) {
        continue;
      }
      seen.add(heading);
      headings.push(heading);
      if (headings.length >= 6) {
        break;
      }
    }
    return headings;
  }

  private extractFirstMeaningfulParagraph(content: string): string {
    const lines = content.split(/\r?\n/);
    const paragraph: string[] = [];
    let insideFence = false;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.startsWith('```')) {
        insideFence = !insideFence;
        if (paragraph.length > 0) {
          break;
        }
        continue;
      }
      if (insideFence) {
        continue;
      }
      if (!line) {
        if (paragraph.length > 0) {
          break;
        }
        continue;
      }
      if (/^#/.test(line) || /^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line) || /^>/.test(line) || /^\|/.test(line)) {
        if (paragraph.length > 0) {
          break;
        }
        continue;
      }
      paragraph.push(line);
      if (paragraph.join(' ').length >= 180) {
        break;
      }
    }

    const normalized = paragraph.join(' ').replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return '';
    }
    return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
  }

  private normalizeRelativePath(inputPath: string): string {
    return inputPath.split(path.sep).join('/');
  }

  private matchesContextAssetTarget(target: string, assetPathSet: Set<string>): boolean {
    if (!target || assetPathSet.size === 0) {
      return false;
    }

    const normalizedDirect = this.normalizeAssetComparePath(target);
    if (assetPathSet.has(normalizedDirect)) {
      return true;
    }

    if (!/[\\/]/.test(target) && !/\.(md|prompt)$/i.test(target) && !/skill\.md$/i.test(target)) {
      return false;
    }

    const resolved = this.normalizeAssetComparePath(path.resolve(process.cwd(), target));
    return assetPathSet.has(resolved);
  }

  private normalizeAssetComparePath(inputPath: string): string {
    return path.resolve(inputPath).replace(/\//g, '\\').replace(/\\+/g, '\\').toLowerCase();
  }

  private getContextHealthSuggestions(level: ContextHealthLevel, confidence: ContextHealthConfidence): string[] {
    const suggestions: string[] = [];
    if (confidence === 'low') {
      suggestions.push(chalk.yellow('Data confidence is low, run /context_health current again after a fresh turn'));
    }

    if (level === 'critical') {
      suggestions.push(
        chalk.red('Compact or reset long chat history before the next heavy turn'),
        chalk.red('Trim project context payload and remove low-relevance docs'),
        chalk.red('Avoid large tool outputs in a single turn and split tasks')
      );
      return suggestions;
    }

    if (level === 'elevated') {
      suggestions.push(
        chalk.yellow('Monitor next few turns and watch for rapid token growth'),
        chalk.yellow('Prefer concise prompts and avoid redundant context blocks')
      );
      return suggestions;
    }

    return suggestions;
  }

  private colorizeLevel(level: ContextHealthLevel): (value: string) => string {
    if (level === 'critical') {
      return chalk.red;
    }
    if (level === 'elevated') {
      return chalk.yellow;
    }
    if (level === 'healthy') {
      return chalk.green;
    }
    return chalk.gray;
  }

  private getNoiseCategoryColor(key: string): (value: string) => string {
    if (key === 'read_dup' || key === 'write_noop') {
      return chalk.red;
    }
    if (key === 'bash_dup' || key === 'grep_miss') {
      return chalk.yellow;
    }
    if (key === 'ctx_stale') {
      return chalk.blue;
    }
    return chalk.gray;
  }

  private renderNoiseTag(tag: 'dup' | 'miss' | 'stale' | 'bloat'): string {
    if (tag === 'dup') {
      return chalk.red('[dup]');
    }
    if (tag === 'miss') {
      return chalk.yellow('[miss]');
    }
    if (tag === 'stale') {
      return chalk.blue('[stale]');
    }
    return chalk.yellow('[bloat]');
  }

  private renderPercentBar(percent: number, colorize: (value: string) => string): string {
    const normalized = Math.max(0, Math.min(100, percent));
    const filledLength = normalized > 0 ? Math.max(1, Math.round((normalized / 100) * CommandHandler.TOKEN_BAR_WIDTH)) : 0;
    const filled = filledLength > 0 ? colorize('#'.repeat(filledLength)) : '';
    const empty = chalk.dim('.'.repeat(Math.max(0, CommandHandler.TOKEN_BAR_WIDTH - filledLength)));
    return `${filled}${empty}`;
  }

  private estimateContextWindowTokens(model: string): number {
    const normalized = model.trim().toLowerCase();
    if (!normalized || normalized === 'unknown') {
      return CommandHandler.DEFAULT_CONTEXT_WINDOW_TOKENS;
    }

    // Most current Claude 3.5/4.x production models use a 200k context window.
    if (normalized.includes('claude')) {
      return 200000;
    }

    return CommandHandler.DEFAULT_CONTEXT_WINDOW_TOKENS;
  }

  private getObjectAtPath(payload: unknown, keyPath: string[]): Record<string, unknown> | null {
    const value = this.getValueAtPath(payload, keyPath);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private getNumberAtPaths(payload: unknown, keyPaths: string[][]): number | null {
    for (const keyPath of keyPaths) {
      const value = this.getValueAtPath(payload, keyPath);
      const normalized = this.normalizeTokenValue(value);
      if (normalized !== null) {
        return normalized;
      }
    }
    return null;
  }

  private getStringAtPaths(payload: unknown, keyPaths: string[][]): string | null {
    for (const keyPath of keyPaths) {
      const value = this.getValueAtPath(payload, keyPath);
      if (typeof value !== 'string') {
        continue;
      }
      const normalized = value.trim();
      if (!normalized) {
        continue;
      }
      return normalized;
    }
    return null;
  }

  private getValueAtPath(payload: unknown, keyPath: string[]): unknown {
    let current: unknown = payload;
    for (const key of keyPath) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        return null;
      }
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  }

  private parseTokenScanRequest(args: string[]): TokenScanRequest {
    if (args.length === 0) {
      return { scope: 'current' };
    }

    const normalized = args[0]?.trim().toLowerCase();
    if (normalized === 'current') {
      return { scope: 'current' };
    }
    if (normalized === 'all') {
      return { scope: 'all' };
    }

    return { scope: 'path', rawPath: args.join(' ').trim() };
  }

  private async resolveTokenScanTarget(request: TokenScanRequest): Promise<TokenScanTarget> {
    if (request.scope === 'path') {
      const inputPath = request.rawPath?.trim();
      if (!inputPath) {
        throw new Error('Missing path. Usage: /scan_tokens [current|all|path]');
      }

      const expandedPath = this.expandHomePath(inputPath);
      const resolvedPath = path.resolve(expandedPath);
      let stat;
      try {
        stat = await fs.stat(resolvedPath);
      } catch {
        throw new Error(`Path not found: ${resolvedPath}`);
      }

      if (stat.isFile()) {
        if (!resolvedPath.toLowerCase().endsWith('.jsonl')) {
          throw new Error(`File is not JSONL: ${resolvedPath}`);
        }
        return {
          scopeLabel: 'explicit_path',
          sourceLabel: resolvedPath,
          projectDirs: [path.dirname(resolvedPath)],
          filePaths: [resolvedPath],
        };
      }

      if (!stat.isDirectory()) {
        throw new Error(`Path is neither a file nor directory: ${resolvedPath}`);
      }

      const filePaths = await this.listRecentJsonlFiles(resolvedPath, CommandHandler.MAX_TOKEN_SCAN_FILES_TOTAL);
      return {
        scopeLabel: 'explicit_path',
        sourceLabel: resolvedPath,
        projectDirs: [resolvedPath],
        filePaths,
      };
    }

    const projectsRoot = await this.resolveClaudeDataDirectory('projects');
    if (!projectsRoot || !(await this.pathExists(projectsRoot))) {
      return {
        scopeLabel: request.scope === 'all' ? 'all_projects' : 'current_project',
        sourceLabel: projectsRoot ?? path.join(os.homedir(), '.claude', 'projects'),
        projectDirs: [],
        filePaths: [],
      };
    }

    const projectDirs =
      request.scope === 'all'
        ? await this.listClaudeProjectDirectories(projectsRoot)
        : await this.resolveClaudeProjectDirectories(projectsRoot, process.cwd());

    const uniqueFiles = new Set<string>();
    const filePaths: string[] = [];
    const perProjectLimit =
      request.scope === 'all'
        ? CommandHandler.MAX_TOKEN_SCAN_FILES_PER_PROJECT_ALL
        : CommandHandler.MAX_TOKEN_SCAN_FILES_PER_PROJECT;

    for (const projectDir of projectDirs) {
      const files = await this.listRecentJsonlFiles(projectDir, perProjectLimit);
      for (const filePath of files) {
        if (uniqueFiles.has(filePath)) {
          continue;
        }
        uniqueFiles.add(filePath);
        filePaths.push(filePath);
        if (filePaths.length >= CommandHandler.MAX_TOKEN_SCAN_FILES_TOTAL) {
          break;
        }
      }
      if (filePaths.length >= CommandHandler.MAX_TOKEN_SCAN_FILES_TOTAL) {
        break;
      }
    }

    return {
      scopeLabel: request.scope === 'all' ? 'all_projects' : 'current_project',
      sourceLabel: request.scope === 'all' ? projectsRoot : path.resolve(process.cwd()),
      projectDirs,
      filePaths,
    };
  }

  private expandHomePath(inputPath: string): string {
    if (inputPath === '~') {
      return os.homedir();
    }
    if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
      return path.join(os.homedir(), inputPath.slice(2));
    }
    return inputPath;
  }

  private async resolveClaudeDataDirectory(childName: 'projects' | 'todos'): Promise<string | null> {
    const candidates = this.buildClaudeDataDirectoryCandidates(childName);
    for (const candidate of candidates) {
      if (await this.pathExists(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  private buildClaudeDataDirectoryCandidates(childName: 'projects' | 'todos'): string[] {
    const candidates = new Set<string>();
    const addCandidate = (basePath: string | undefined | null): void => {
      if (!basePath) {
        return;
      }
      const trimmed = basePath.trim();
      if (!trimmed) {
        return;
      }
      candidates.add(path.resolve(trimmed, childName));
    };

    addCandidate(path.join(os.homedir(), '.claude'));
    addCandidate(process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.claude') : null);
    addCandidate(process.env.HOME ? path.join(process.env.HOME, '.claude') : null);

    if (process.env.HOMEDRIVE && process.env.HOMEPATH) {
      addCandidate(path.join(`${process.env.HOMEDRIVE}${process.env.HOMEPATH}`, '.claude'));
    }

    const cwdParts = path.resolve(process.cwd()).split(path.sep).filter((part) => part.length > 0);
    if (cwdParts.length >= 3 && cwdParts[1]?.toLowerCase() === 'users') {
      addCandidate(path.join(cwdParts[0] ?? '', 'Users', cwdParts[2] ?? '', '.claude'));
    }

    return Array.from(candidates);
  }

  private async listClaudeProjectDirectories(projectsRoot: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(projectsRoot, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(projectsRoot, entry.name))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  private async buildTokenStructureSummary(filePaths: string[]): Promise<TokenStructureSummary> {
    const fieldMap = new Map<string, { total: number; count: number }>();
    const roleMap = new Map<string, { totalTokens: number; records: number }>();
    const typeMap = new Map<string, { totalTokens: number; records: number }>();
    const dayMap = new Map<string, { totalTokens: number; records: number }>();
    const files: TokenFileAggregate[] = [];

    let totalLines = 0;
    let parsedLines = 0;
    let invalidLines = 0;
    let recordsWithTokens = 0;
    let totalTokens = 0;

    for (const filePath of filePaths) {
      const fileSummary = await this.analyzeTokenJsonlFile(filePath, fieldMap, roleMap, typeMap, dayMap);
      files.push(fileSummary);
      totalLines += fileSummary.totalLines;
      parsedLines += fileSummary.parsedLines;
      invalidLines += fileSummary.invalidLines;
      recordsWithTokens += fileSummary.recordsWithTokens;
      totalTokens += fileSummary.totalTokens;
    }

    const tokenFields: TokenFieldAggregate[] = Array.from(fieldMap.entries())
      .map(([name, value]) => ({ name, total: value.total, count: value.count }))
      .sort((a, b) => b.total - a.total || b.count - a.count || a.name.localeCompare(b.name));

    const roleBreakdown: TokenGroupAggregate[] = Array.from(roleMap.entries())
      .map(([name, value]) => ({ name, totalTokens: value.totalTokens, records: value.records }))
      .sort((a, b) => b.totalTokens - a.totalTokens || b.records - a.records || a.name.localeCompare(b.name));

    const typeBreakdown: TokenGroupAggregate[] = Array.from(typeMap.entries())
      .map(([name, value]) => ({ name, totalTokens: value.totalTokens, records: value.records }))
      .sort((a, b) => b.totalTokens - a.totalTokens || b.records - a.records || a.name.localeCompare(b.name));

    const dayBreakdown: TokenDayAggregate[] = Array.from(dayMap.entries())
      .map(([day, value]) => ({ day, totalTokens: value.totalTokens, records: value.records }))
      .sort((a, b) => a.day.localeCompare(b.day));

    const sortedFiles = files
      .slice()
      .sort((a, b) => b.totalTokens - a.totalTokens || b.parsedLines - a.parsedLines || a.filePath.localeCompare(b.filePath));

    return {
      files: sortedFiles,
      totalFiles: sortedFiles.length,
      totalLines,
      parsedLines,
      invalidLines,
      recordsWithTokens,
      totalTokens,
      tokenFields,
      roleBreakdown,
      typeBreakdown,
      dayBreakdown,
    };
  }

  private async analyzeTokenJsonlFile(
    filePath: string,
    fieldMap: Map<string, { total: number; count: number }>,
    roleMap: Map<string, { totalTokens: number; records: number }>,
    typeMap: Map<string, { totalTokens: number; records: number }>,
    dayMap: Map<string, { totalTokens: number; records: number }>
  ): Promise<TokenFileAggregate> {
    let raw = '';
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch {
      return {
        filePath,
        projectDir: path.dirname(filePath),
        totalLines: 0,
        parsedLines: 0,
        invalidLines: 0,
        recordsWithTokens: 0,
        totalTokens: 0,
        latestTimestampMs: 0,
      };
    }

    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    let latestTimestampMs = 0;
    try {
      const stat = await fs.stat(filePath);
      latestTimestampMs = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0;
    } catch {
      latestTimestampMs = 0;
    }

    let parsedLines = 0;
    let invalidLines = 0;
    let recordsWithTokens = 0;
    let totalTokens = 0;

    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        invalidLines += 1;
        continue;
      }

      parsedLines += 1;
      const lineSummary = this.summarizeTokenLine(parsed);
      totalTokens += lineSummary.totalTokens;
      if (lineSummary.totalTokens > 0) {
        recordsWithTokens += 1;
      }
      if (lineSummary.timestampMs > latestTimestampMs) {
        latestTimestampMs = lineSummary.timestampMs;
      }

      lineSummary.fields.forEach((field) => {
        const current = fieldMap.get(field.name) ?? { total: 0, count: 0 };
        current.total += field.value;
        current.count += 1;
        fieldMap.set(field.name, current);
      });

      const roleName = lineSummary.role || 'unknown';
      const currentRole = roleMap.get(roleName) ?? { totalTokens: 0, records: 0 };
      currentRole.totalTokens += lineSummary.totalTokens;
      currentRole.records += 1;
      roleMap.set(roleName, currentRole);

      const typeName = lineSummary.type || 'unknown';
      const currentType = typeMap.get(typeName) ?? { totalTokens: 0, records: 0 };
      currentType.totalTokens += lineSummary.totalTokens;
      currentType.records += 1;
      typeMap.set(typeName, currentType);

      const dayKey = this.toDayKey(lineSummary.timestampMs);
      if (dayKey) {
        const currentDay = dayMap.get(dayKey) ?? { totalTokens: 0, records: 0 };
        currentDay.totalTokens += lineSummary.totalTokens;
        currentDay.records += 1;
        dayMap.set(dayKey, currentDay);
      }
    }

    return {
      filePath,
      projectDir: path.dirname(filePath),
      totalLines: lines.length,
      parsedLines,
      invalidLines,
      recordsWithTokens,
      totalTokens,
      latestTimestampMs,
    };
  }

  private summarizeTokenLine(payload: unknown): {
    fields: Array<{ name: string; value: number }>;
    totalTokens: number;
    role: string;
    type: string;
    timestampMs: number;
  } {
    const fields: Array<{ name: string; value: number }> = [];
    this.extractTokenFieldsFromPayload(payload, '', fields);
    const totalTokens = fields.reduce((sum, field) => sum + field.value, 0);
    const role = this.extractTokenRoleFromPayload(payload);
    const type = this.extractTokenTypeFromPayload(payload);
    const timestampMs = this.extractTokenTimestampMs(payload);
    return {
      fields,
      totalTokens,
      role,
      type,
      timestampMs,
    };
  }

  private extractTokenFieldsFromPayload(
    payload: unknown,
    prefix: string,
    fields: Array<{ name: string; value: number }>
  ): void {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    if (Array.isArray(payload)) {
      payload.forEach((item) => {
        const nextPrefix = prefix ? `${prefix}[]` : '[]';
        this.extractTokenFieldsFromPayload(item, nextPrefix, fields);
      });
      return;
    }

    const record = payload as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      const nextPrefix = prefix ? `${prefix}.${key}` : key;
      const maybeToken = this.normalizeTokenValue(value);
      if (this.isLikelyTokenKey(key) && maybeToken !== null) {
        fields.push({ name: nextPrefix, value: maybeToken });
      }

      if (value && typeof value === 'object') {
        this.extractTokenFieldsFromPayload(value, nextPrefix, fields);
      }
    }
  }

  private isLikelyTokenKey(key: string): boolean {
    return /token/i.test(key);
  }

  private normalizeTokenValue(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, value);
    }

    if (typeof value !== 'string') {
      return null;
    }

    const trimmed = value.trim();
    if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
      return null;
    }

    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    return Math.max(0, parsed);
  }

  private extractTokenRoleFromPayload(payload: unknown): string {
    if (!payload || typeof payload !== 'object') {
      return 'unknown';
    }

    const record = payload as Record<string, unknown>;
    const message = record.message && typeof record.message === 'object' ? (record.message as Record<string, unknown>) : null;
    const candidates: unknown[] = [
      record.role,
      message?.role,
      record.type,
      message?.type,
      record.actor,
      record.source,
    ];

    for (const candidate of candidates) {
      if (typeof candidate !== 'string') {
        continue;
      }
      const normalized = candidate.trim().toLowerCase();
      if (!normalized) {
        continue;
      }
      if (normalized.includes('assistant')) {
        return 'assistant';
      }
      if (normalized.includes('user')) {
        return 'user';
      }
      if (normalized.includes('system')) {
        return 'system';
      }
      if (normalized.includes('tool')) {
        return 'tool';
      }
      return normalized;
    }

    return 'unknown';
  }

  private extractTokenTypeFromPayload(payload: unknown): string {
    if (!payload || typeof payload !== 'object') {
      return 'unknown';
    }

    const record = payload as Record<string, unknown>;
    const message = record.message && typeof record.message === 'object' ? (record.message as Record<string, unknown>) : null;
    const candidates: unknown[] = [record.type, message?.type, record.event, record.kind];

    for (const candidate of candidates) {
      if (typeof candidate !== 'string') {
        continue;
      }
      const normalized = candidate.trim().toLowerCase();
      if (!normalized) {
        continue;
      }
      if (normalized.length <= 36) {
        return normalized;
      }
      return `${normalized.slice(0, 33)}...`;
    }

    return 'unknown';
  }

  private extractTokenTimestampMs(payload: unknown): number {
    if (!payload || typeof payload !== 'object') {
      return 0;
    }

    const record = payload as Record<string, unknown>;
    const message = record.message && typeof record.message === 'object' ? (record.message as Record<string, unknown>) : null;
    const candidates: unknown[] = [
      record.timestamp,
      record.created_at,
      record.createdAt,
      record.time,
      message?.timestamp,
      message?.created_at,
      message?.createdAt,
      message?.time,
    ];

    for (const candidate of candidates) {
      const parsed = this.parseTimestampValue(candidate);
      if (parsed > 0) {
        return parsed;
      }
    }

    return 0;
  }

  private parseTimestampValue(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (value > 1000000000000) {
        return value;
      }
      if (value > 1000000000) {
        return value * 1000;
      }
      return 0;
    }

    if (typeof value !== 'string') {
      return 0;
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return 0;
    }

    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isFinite(numeric)) {
        return 0;
      }
      if (numeric > 1000000000000) {
        return numeric;
      }
      if (numeric > 1000000000) {
        return numeric * 1000;
      }
      return 0;
    }

    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
    return 0;
  }

  private toDayKey(timestampMs: number): string {
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
      return '';
    }

    const date = new Date(timestampMs);
    const year = `${date.getFullYear()}`;
    const month = `${date.getMonth() + 1}`.padStart(2, '0');
    const day = `${date.getDate()}`.padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private renderTokenStructureSummary(target: TokenScanTarget, summary: TokenStructureSummary): void {
    const mostRecentMs = summary.files.reduce((max, file) => Math.max(max, file.latestTimestampMs), 0);
    const headerLines: string[] = [
      `Scope: ${target.scopeLabel}`,
      `Source: ${target.sourceLabel}`,
      `Project dirs: ${target.projectDirs.length}`,
      `JSONL files: ${summary.totalFiles}`,
      `Records: ${this.formatTokenNumber(summary.parsedLines)} parsed / ${this.formatTokenNumber(summary.invalidLines)} invalid`,
      `Records with token fields: ${this.formatTokenNumber(summary.recordsWithTokens)}`,
      `Total token values: ${this.formatTokenNumber(Math.round(summary.totalTokens))}`,
    ];

    if (mostRecentMs > 0) {
      headerLines.push(`Most recent activity: ${new Date(mostRecentMs).toLocaleString()}`);
    }

    console.log(
      boxen(headerLines.join('\n'), {
        borderStyle: 'round',
        borderColor: 'gray',
        title: ' Token Structure ',
        titleAlignment: 'left',
        padding: { top: 0, right: 1, bottom: 0, left: 1 },
      })
    );

    this.renderTokenFieldSection(summary.tokenFields.slice(0, 10));
    this.renderTokenGroupSection('Role Token Breakdown', summary.roleBreakdown.slice(0, 8), chalk.cyan);
    this.renderTokenGroupSection('Event Type Token Breakdown', summary.typeBreakdown.slice(0, 8), chalk.green);
    this.renderTokenFileSection(summary.files.slice(0, 8));
    this.renderTokenDaySection(summary.dayBreakdown.slice(-7));
  }

  private renderTokenFieldSection(fields: TokenFieldAggregate[]): void {
    console.log('');
    console.log(chalk.bold('  Token Fields (Top 10)'));
    if (fields.length === 0) {
      console.log(chalk.dim('  - (no token fields found)'));
      return;
    }

    const maxValue = fields.reduce((max, field) => Math.max(max, field.total), 0);
    fields.forEach((field) => {
      const label = this.truncateBlockName(field.name, 34).padEnd(34, ' ');
      const row = this.renderTokenBar(field.total, maxValue, chalk.blue);
      const valueText = this.formatTokenNumber(Math.round(field.total)).padStart(9, ' ');
      console.log(`  ${row} ${label} ${valueText} tok ${chalk.dim(`${field.count} hits`)}`);
    });
  }

  private renderTokenGroupSection(
    title: string,
    groups: TokenGroupAggregate[],
    colorize: (value: string) => string
  ): void {
    console.log('');
    console.log(chalk.bold(`  ${title}`));
    if (groups.length === 0) {
      console.log(chalk.dim('  - (none)'));
      return;
    }

    const maxValue = groups.reduce((max, group) => Math.max(max, group.totalTokens), 0);
    groups.forEach((group) => {
      const label = this.truncateBlockName(group.name, 22).padEnd(22, ' ');
      const row = this.renderTokenBar(group.totalTokens, maxValue, colorize);
      const valueText = this.formatTokenNumber(Math.round(group.totalTokens)).padStart(9, ' ');
      const recordsText = `${this.formatTokenNumber(group.records)} records`;
      console.log(`  ${row} ${label} ${valueText} tok ${chalk.dim(recordsText)}`);
    });
  }

  private renderTokenFileSection(files: TokenFileAggregate[]): void {
    console.log('');
    console.log(chalk.bold('  Top JSONL Files'));
    if (files.length === 0) {
      console.log(chalk.dim('  - (none)'));
      return;
    }

    files.forEach((file) => {
      const relativePath = path.relative(process.cwd(), file.filePath);
      const displayPath =
        relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath) ? relativePath : file.filePath;
      const tokenText = this.formatTokenNumber(Math.round(file.totalTokens)).padStart(9, ' ');
      const linesText = `${this.formatTokenNumber(file.parsedLines)} parsed / ${this.formatTokenNumber(file.invalidLines)} invalid`;
      console.log(`  - ${chalk.cyan(this.truncateBlockName(displayPath, 64))}`);
      console.log(`    ${tokenText} tok  ${chalk.dim(linesText)}`);
    });
  }

  private renderTokenDaySection(days: TokenDayAggregate[]): void {
    console.log('');
    console.log(chalk.bold('  Daily Trend (Last 7 Days)'));
    if (days.length === 0) {
      console.log(chalk.dim('  - (no timestamp data)'));
      return;
    }

    const maxValue = days.reduce((max, day) => Math.max(max, day.totalTokens), 0);
    days.forEach((day) => {
      const row = this.renderTokenBar(day.totalTokens, maxValue, chalk.yellow);
      const valueText = this.formatTokenNumber(Math.round(day.totalTokens)).padStart(9, ' ');
      console.log(`  ${row} ${day.day}  ${valueText} tok ${chalk.dim(`${day.records} records`)}`);
    });
  }

  private renderTokenBar(value: number, maxValue: number, colorize: (value: string) => string): string {
    if (maxValue <= 0 || value <= 0) {
      return chalk.dim('.'.repeat(CommandHandler.TOKEN_BAR_WIDTH));
    }
    const ratio = Math.max(0, Math.min(1, value / maxValue));
    const filledLength = Math.max(1, Math.round(ratio * CommandHandler.TOKEN_BAR_WIDTH));
    const filled = colorize('#'.repeat(filledLength));
    const empty = chalk.dim('.'.repeat(Math.max(0, CommandHandler.TOKEN_BAR_WIDTH - filledLength)));
    return `${filled}${empty}`;
  }

  private formatTokenNumber(value: number): string {
    return Math.round(value).toLocaleString('en-US');
  }

  private async scanSkills(args: string[]): Promise<void> {
    const spinner = process.stdout.isTTY ? new Spinner() : null;
    if (spinner) {
      spinner.start('Scanning workspace skills...');
    } else {
      this.uiRenderer.renderInfo('Scanning workspace skills...');
    }

    try {
      const requestedPath = args.join(' ').trim();
      const targetPath = requestedPath ? path.resolve(process.cwd(), requestedPath) : process.cwd();
      const targetStat = await fs.stat(targetPath);
      if (!targetStat.isDirectory()) {
        throw new Error(`Skills scan target is not a directory: ${targetPath}`);
      }

      const result = await this.skillScanner.scan(targetPath);
      if (spinner) {
        spinner.stop('Skills scan completed');
      } else {
        this.uiRenderer.renderSuccess('Skills scan completed');
      }

      this.renderSkillsOverview(result);
      this.recordCommandData(
        'skills',
        [
          `root=${result.rootPath}`,
          `scannedFiles=${result.scannedFileCount}`,
          `skills=${result.skills.length}`,
          `supportFiles=${result.totalResourceFiles}`,
          ...result.skills.slice(0, 12).map((skill) => {
            const resources =
              skill.resourceSummaries.length > 0
                ? skill.resourceSummaries.map((resource) => `${resource.label}:${resource.fileCount}`).join(', ')
                : 'none';
            return `${skill.name} | ${skill.relativeDir} | ${skill.purpose} | resources=${resources}`;
          }),
        ].join('\n')
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to scan skills';
      if (spinner) {
        spinner.fail(message);
      } else {
        this.uiRenderer.renderError(message);
      }
      this.recordCommandData('skills', `failed: ${message}`);
    }
  }

  private renderSkillsOverview(result: SkillScanResult): void {
    const totalInstructionTokens = result.skills.reduce((sum, skill) => sum + skill.instructionTokenEstimate, 0);
    const skillFolders = new Set(result.skills.map((skill) => skill.relativeDir)).size;
    const resourceCoverage = this.buildSkillCoverageSummary(result.skills);
    const overviewLines = [
      `${chalk.gray('Workspace')} ${chalk.white(result.rootPath)}`,
      `${chalk.gray('Scanned files')} ${chalk.white(result.scannedFileCount)}    ${chalk.gray('Skills')} ${chalk.cyan(
        result.skills.length
      )}    ${chalk.gray('Skill folders')} ${chalk.white(skillFolders)}`,
      `${chalk.gray('Instruction footprint')} ${chalk.white(this.formatTokenNumber(totalInstructionTokens))} tok    ${chalk.gray(
        'Support files'
      )} ${chalk.white(result.totalResourceFiles)}`,
      `${chalk.gray('Coverage')} ${resourceCoverage}`,
    ];

    console.log('');
    console.log(
      boxen(overviewLines.join('\n'), {
        borderStyle: 'round',
        borderColor: 'cyan',
        title: ' Skills Workspace ',
        titleAlignment: 'left',
        padding: { top: 0, right: 1, bottom: 0, left: 1 },
      })
    );

    if (result.skills.length === 0) {
      console.log('');
      console.log(chalk.yellow('  No SKILL.md files found in this directory tree.'));
      console.log(chalk.dim('  Tip: add a skill folder that contains a SKILL.md file, then run /skills again.'));
      return;
    }

    result.skills.forEach((skill, index) => {
      console.log('');
      console.log(this.renderSkillCard(skill, index));
    });
  }

  private buildSkillCoverageSummary(skills: SkillSummary[]): string {
    if (skills.length === 0) {
      return chalk.dim('no skill resources detected yet');
    }

    const counts = {
      agents: 0,
      scripts: 0,
      references: 0,
      assets: 0,
      extras: 0,
    };

    skills.forEach((skill) => {
      if (skill.resourceSummaries.some((resource) => resource.kind === 'agents' && resource.fileCount > 0)) {
        counts.agents += 1;
      }
      if (skill.resourceSummaries.some((resource) => resource.kind === 'scripts' && resource.fileCount > 0)) {
        counts.scripts += 1;
      }
      if (skill.resourceSummaries.some((resource) => resource.kind === 'references' && resource.fileCount > 0)) {
        counts.references += 1;
      }
      if (skill.resourceSummaries.some((resource) => resource.kind === 'assets' && resource.fileCount > 0)) {
        counts.assets += 1;
      }
      if (skill.resourceSummaries.some((resource) => resource.kind === 'other' && resource.fileCount > 0)) {
        counts.extras += 1;
      }
    });

    const chips: string[] = [];
    if (counts.agents > 0) {
      chips.push(chalk.cyan(`agents ${counts.agents}`));
    }
    if (counts.scripts > 0) {
      chips.push(chalk.magenta(`scripts ${counts.scripts}`));
    }
    if (counts.references > 0) {
      chips.push(chalk.green(`references ${counts.references}`));
    }
    if (counts.assets > 0) {
      chips.push(chalk.yellow(`assets ${counts.assets}`));
    }
    if (counts.extras > 0) {
      chips.push(chalk.gray(`extras ${counts.extras}`));
    }

    return chips.length > 0 ? chips.join(chalk.dim('  ·  ')) : chalk.dim('SKILL.md only');
  }

  private renderSkillCard(skill: SkillSummary, index: number): string {
    const cardWidth = this.getSkillCardWidth();
    const contentWidth = Math.max(24, cardWidth - 6);
    const relatedLine =
      skill.resourceSummaries.length > 0
        ? skill.resourceSummaries.map((resource) => `${resource.label} (${resource.fileCount})`).join(', ')
        : 'SKILL.md only';
    const samplePaths = skill.resourceSummaries.flatMap((resource) => resource.samplePaths).slice(0, 4).join(', ');
    const sectionList = skill.headings.join(' · ');
    const footprint = `SKILL.md ~${this.formatTokenNumber(skill.instructionTokenEstimate)} tok, support files ${skill.totalResourceFiles}`;

    const lines: string[] = [];
    lines.push(...this.wrapSkillField('Purpose', skill.purpose, contentWidth));

    if (skill.whenToUse) {
      lines.push(...this.wrapSkillField('When to use', skill.whenToUse, contentWidth));
    } else if (skill.description && this.normalizeSkillText(skill.description) !== this.normalizeSkillText(skill.purpose)) {
      lines.push(...this.wrapSkillField('Description', skill.description, contentWidth));
    }

    lines.push(...this.wrapSkillField('Path', skill.relativeDir, contentWidth));
    lines.push(...this.wrapSkillField('Core file', skill.skillFileRelativePath, contentWidth));
    lines.push(...this.wrapSkillField('Related', relatedLine, contentWidth));

    if (samplePaths) {
      lines.push(...this.wrapSkillField('Samples', samplePaths, contentWidth));
    }

    if (sectionList) {
      lines.push(...this.wrapSkillField('Sections', sectionList, contentWidth));
    }

    lines.push(...this.wrapSkillField('Footprint', footprint, contentWidth));

    const borderColors = ['cyan', 'green', 'yellow', 'magenta'] as const;
    return boxen(lines.join('\n'), {
      borderStyle: 'round',
      borderColor: borderColors[index % borderColors.length],
      title: ` ${skill.title} `,
      titleAlignment: 'left',
      padding: { top: 0, right: 1, bottom: 0, left: 1 },
      width: cardWidth,
    });
  }

  private getSkillCardWidth(): number {
    const terminalWidth = process.stdout.columns ?? 120;
    return Math.max(44, Math.min(100, terminalWidth - 2));
  }

  private wrapSkillField(label: string, value: string, width: number): string[] {
    const normalizedValue = this.normalizeSkillText(value);
    if (!normalizedValue) {
      return [];
    }

    const prefix = `${label}: `;
    const continuationPrefix = ' '.repeat(prefix.length);
    const wrapped = this.wrapPlainText(normalizedValue, Math.max(16, width - prefix.length));

    return wrapped.map((line, index) =>
      index === 0 ? `${chalk.gray(prefix)}${chalk.white(line)}` : `${chalk.gray(continuationPrefix)}${chalk.white(line)}`
    );
  }

  private wrapPlainText(value: string, maxWidth: number): string[] {
    if (value.length <= maxWidth) {
      return [value];
    }

    const words = value.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      return [''];
    }

    const lines: string[] = [];
    let current = '';

    for (const word of words) {
      if (word.length > maxWidth) {
        if (current) {
          lines.push(current);
          current = '';
        }

        for (let index = 0; index < word.length; index += maxWidth) {
          lines.push(word.slice(index, index + maxWidth));
        }
        continue;
      }

      const next = current ? `${current} ${word}` : word;
      if (next.length > maxWidth) {
        lines.push(current);
        current = word;
      } else {
        current = next;
      }
    }

    if (current) {
      lines.push(current);
    }

    return lines;
  }

  private normalizeSkillText(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }

  private async scanPromptAssets(): Promise<void> {
    const spinner = process.stdout.isTTY ? new Spinner() : null;
    if (spinner) {
      spinner.start('Analyzing prompt assets...');
    } else {
      this.uiRenderer.renderInfo('Analyzing prompt assets...');
    }

    try {
      const { mode, warning, result, anatomyView } = await this.withTimeout(
        async () => {
          const tokenization = await this.resolvePromptScanTokenizationStrategy();
          const result = await this.promptAssetScanner.scan(process.cwd(), {
            tokenCounter: (text, _filePath) => tokenization.countTokens(text),
          });
          const anatomyView = await this.buildContextAnatomyView(result.files, tokenization.countTokens);
          return {
            mode: tokenization.getMode(),
            warning: tokenization.getWarning(),
            result,
            anatomyView,
          };
        },
        CommandHandler.SCAN_PROMPT_TIMEOUT_MS,
        `/scan_prompt timed out after ${this.formatTimeoutMs(CommandHandler.SCAN_PROMPT_TIMEOUT_MS)}.`
      );
      if (spinner) {
        spinner.stop('Prompt analysis completed');
      } else {
        this.uiRenderer.renderSuccess('Prompt analysis completed');
      }

      const modeLabel =
        mode === 'count_tokens'
          ? 'messages/count_tokens'
          : mode === 'messages_usage'
            ? 'messages usage.input_tokens'
            : 'local estimated tokens';
      this.uiRenderer.renderInfo(`Tokenizer mode: ${modeLabel}`);
      if (warning) {
        this.uiRenderer.renderWarning(warning);
      }

      console.log('');
      console.log(chalk.bold('  Prompt Asset Scan'));
      console.log(chalk.dim('  - ') + chalk.gray('Project: ') + chalk.white(result.rootPath));
      console.log(chalk.dim('  - ') + chalk.gray('Scanned files: ') + chalk.white(result.scannedFileCount));
      console.log(chalk.dim('  - ') + chalk.gray('Prompt assets: ') + chalk.white(result.files.length));

      if (result.files.length === 0) {
        this.uiRenderer.renderWarning('No prompt assets found in current directory');
        this.renderContextAnatomyView(anatomyView);
        this.recordCommandData(
          'scan_prompt',
          [
            `project=${result.rootPath}`,
            `scannedFiles=${result.scannedFileCount}`,
            'promptAssets=0',
            `tokenizerMode=${modeLabel}`,
            'contextAnatomy:',
            ...anatomyView.summary,
          ].join('\n')
        );
        return;
      }

      const categoryOrder: PromptAssetCategory[] = ['project-config', 'prompt-file', 'rules', 'system-prompt', 'docs'];
      const categoryNames: Record<PromptAssetCategory, string> = {
        'project-config': 'Project Config',
        'prompt-file': '.prompt Files',
        rules: 'rules/ Files',
        'system-prompt': 'System Prompt',
        docs: 'docs/ Files',
      };

      console.log('');
      console.log(chalk.bold('  Categories'));
      categoryOrder.forEach((category) => {
        const count = result.files.filter((file) => file.categories.includes(category)).length;
        if (count > 0) {
          console.log(chalk.dim('  - ') + chalk.gray(categoryNames[category] + ': ') + chalk.white(count));
        }
      });

      console.log('');
      console.log(chalk.bold('  Files'));
      result.files.forEach((file) => {
        const tag = file.categories.map((category) => categoryNames[category]).join(', ');
        const tokenInfo = file.tokenCount > 0 ? `${file.tokenCount.toString().padStart(5)} tok` : '  n/a tok';
        console.log(chalk.dim('  - ') + chalk.cyan(file.relativePath) + chalk.dim(`  ${tokenInfo}  [${tag}]`));
      });
      console.log('');

      this.renderContextAnatomyView(anatomyView);
      const topFiles = result.files
        .slice()
        .sort((a, b) => b.tokenCount - a.tokenCount || a.relativePath.localeCompare(b.relativePath))
        .slice(0, 12)
        .map((file) => `${file.relativePath} (${file.tokenCount} tok, ${file.categories.join('|')})`)
        .join('\n');
      this.recordCommandData(
        'scan_prompt',
        [
          `project=${result.rootPath}`,
          `scannedFiles=${result.scannedFileCount}`,
          `promptAssets=${result.files.length}`,
          `tokenizerMode=${modeLabel}`,
          'contextAnatomy:',
          ...anatomyView.summary,
          'topFiles:',
          topFiles || '(none)',
        ].join('\n')
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to scan prompt assets';
      if (spinner) {
        spinner.fail(message);
      } else {
        this.uiRenderer.renderError(message);
      }
      this.recordCommandData('scan_prompt', `failed: ${message}`);
    }
  }

  private async withTimeout<T>(task: () => Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs);

      task()
        .then((value) => {
          clearTimeout(timeoutHandle);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timeoutHandle);
          reject(error);
        });
    });
  }

  private async resolvePromptScanTokenizationStrategy(): Promise<PromptScanTokenizationStrategy> {
    let mode: PromptScanTokenizerMode = 'estimated';
    let warning: string | undefined;

    try {
      mode = await this.claudeTokenizer.getActiveMode();
    } catch (error) {
      warning = this.formatPromptScanTokenizerFallbackWarning(error);
    }

    return {
      countTokens: async (text: string) => {
        if (mode === 'estimated') {
          return estimateTokenCount(text);
        }

        try {
          return await this.claudeTokenizer.countTextTokens(text);
        } catch (error) {
          mode = 'estimated';
          warning ??= this.formatPromptScanTokenizerFallbackWarning(error);
          return estimateTokenCount(text);
        }
      },
      getMode: () => mode,
      getWarning: () => warning,
    };
  }

  private formatPromptScanTokenizerFallbackWarning(error: unknown): string {
    const message = error instanceof Error ? error.message : 'Unknown tokenizer error';
    return `Tokenizer unavailable. Falling back to local token estimates. Reason: ${message}`;
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

  private async buildContextAnatomyLines(
    files: Array<{ relativePath: string; categories: PromptAssetCategory[]; tokenCount: number }>
  ): Promise<string[]> {
    const systemFiles = files.filter((file) =>
      file.categories.includes('project-config') || file.categories.includes('system-prompt')
    );
    const docsFiles = files.filter(
      (file) =>
        !systemFiles.some((systemFile) => systemFile.relativePath === file.relativePath) &&
        file.categories.includes('docs')
    );

    const systemPromptTokens = systemFiles.reduce((sum, file) => sum + file.tokenCount, 0);
    const docsTokens = docsFiles.reduce((sum, file) => sum + file.tokenCount, 0);

    const messages = this.conversationManager.getMessages();
    const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user');
    const userMessageTokens = latestUserMessage ? await this.claudeTokenizer.countTextTokens(latestUserMessage.content) : 0;
    const historyParts = await Promise.all(
      messages
        .filter((message) => message.id !== latestUserMessage?.id)
        .map((message) => this.claudeTokenizer.countTextTokens(message.content))
    );
    const historyTokens = historyParts.reduce((sum, value) => sum + value, 0);

    const totalTokens = systemPromptTokens + docsTokens + historyTokens + userMessageTokens;
    const contextLimit = await this.resolveContextAnatomyLimit();
    const truncatedTokens = Math.max(0, totalTokens - contextLimit.usableContextTokens);
    const denominator = Math.max(1, totalTokens);

    const buckets: AnatomyBucket[] = [
      this.createAnatomyBucket('System Prompt', systemPromptTokens, denominator, chalk.blue),
      this.createAnatomyBucket('Docs', docsTokens, denominator, chalk.green),
      this.createAnatomyBucket('History', historyTokens, denominator, chalk.yellow),
      this.createAnatomyBucket('User Message', userMessageTokens, denominator, chalk.white),
    ];

    const lines: string[] = [];
    lines.push(chalk.bold('Segment          Tokens       Share   Context Load'));
    lines.push(chalk.dim('────────────────────────────────────────────────────────'));
    buckets.forEach((bucket) => {
      lines.push(this.renderAnatomyRow(bucket));
    });

    const docDetailFiles = docsFiles
      .slice()
      .sort((a, b) => b.tokenCount - a.tokenCount || a.relativePath.localeCompare(b.relativePath))
      .slice(0, 6);

    if (docDetailFiles.length > 0) {
      const docsIndex = buckets.findIndex((bucket) => bucket.name === 'Docs');
      if (docsIndex >= 0) {
        const rowOffset = 2; // header + divider
        docDetailFiles.forEach((file, index) => {
          const branch = index === docDetailFiles.length - 1 ? '`-' : '|-';
          lines.splice(
            rowOffset + docsIndex + 1 + index,
            0,
            chalk.dim(
              `${' '.repeat(2)}${branch} ${this.truncatePathForAnatomy(file.relativePath).padEnd(28, ' ')} ${this
                .formatTokenNumber(file.tokenCount)
                .padStart(8, ' ')} tok`
            )
          );
        });
      }
    }

    lines.push(chalk.dim('────────────────────────────────────────────────────────'));
    lines.push(
      chalk.dim(
        `Context window estimate: ${this.formatTokenNumber(contextLimit.contextWindowTokens)} tok (model: ${contextLimit.model})`
      )
    );
    lines.push(
      chalk.dim(
        `Usable estimate: ${this.formatTokenNumber(contextLimit.usableContextTokens)} tok (reserve ${this.formatTokenNumber(
          contextLimit.bufferTokens
        )} tok)`
      )
    );
    if (truncatedTokens > 0) {
      lines.push(chalk.red(`Potential overflow: ${this.formatTokenNumber(truncatedTokens)} tok beyond usable estimate`));
    }
    return lines;
  }

  private renderContextAnatomy(lines: string[]): void {
    console.log(
      boxen(lines.join('\n'), {
        borderStyle: 'round',
        borderColor: 'cyan',
        title: ' Context Anatomy ',
        titleAlignment: 'left',
        padding: { top: 0, right: 1, bottom: 0, left: 1 },
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
      })
    );
  }

  private async buildContextAnatomyView(
    files: Array<{ relativePath: string; categories: PromptAssetCategory[]; tokenCount: number }>,
    countTokens: PromptScanTokenCounter
  ): Promise<ContextAnatomyView> {
    const systemFiles: Array<{ relativePath: string; categories: PromptAssetCategory[]; tokenCount: number }> = [];
    const promptLibraryFiles: Array<{ relativePath: string; categories: PromptAssetCategory[]; tokenCount: number }> = [];
    const referenceDocsFiles: Array<{ relativePath: string; categories: PromptAssetCategory[]; tokenCount: number }> = [];

    files.forEach((file) => {
      const bucket = this.classifyPromptAssetForAnatomy(file);
      if (bucket === 'system') {
        systemFiles.push(file);
        return;
      }
      if (bucket === 'prompt_library') {
        promptLibraryFiles.push(file);
        return;
      }
      referenceDocsFiles.push(file);
    });

    const systemPromptTokens = systemFiles.reduce((sum, file) => sum + file.tokenCount, 0);
    const promptLibraryTokens = promptLibraryFiles.reduce((sum, file) => sum + file.tokenCount, 0);
    const docsTokens = referenceDocsFiles.reduce((sum, file) => sum + file.tokenCount, 0);

    const messages = this.conversationManager.getMessages();
    const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user');
    const historyMessages = messages.filter((message) => message.id !== latestUserMessage?.id);
    const [userMessageTokens, historyTokenParts] = await Promise.all([
      latestUserMessage ? countTokens(latestUserMessage.content) : Promise.resolve(0),
      Promise.all(historyMessages.map((message) => countTokens(message.content))),
    ]);
    const historyTokens = historyTokenParts.reduce((sum, value) => sum + value, 0);

    const totalTokens = systemPromptTokens + promptLibraryTokens + docsTokens + historyTokens + userMessageTokens;
    const contextLimit = await this.resolveContextAnatomyLimit();
    const overflowTokens = Math.max(0, totalTokens - contextLimit.usableContextTokens);
    const usableHeadroom = Math.max(0, contextLimit.usableContextTokens - totalTokens);
    const hardHeadroom = Math.max(0, contextLimit.contextWindowTokens - totalTokens);
    const budgetUtilization = contextLimit.usableContextTokens <= 0 ? 0 : totalTokens / contextLimit.usableContextTokens;
    const latestUserShare = totalTokens <= 0 ? 0 : userMessageTokens / totalTokens;
    const turnDepthRatio = totalTokens <= 0 ? 0 : Math.max(0, (totalTokens - userMessageTokens) / totalTokens);

    const segmentDefinitions: Array<{
      key: ContextAnatomySegmentKey;
      label: string;
      shortLabel: string;
      tokenCount: number;
      itemCount: number;
      colorize: (value: string) => string;
      barChar: string;
    }> = [
      {
        key: 'system',
        label: 'Core instructions',
        shortLabel: 'S',
        tokenCount: systemPromptTokens,
        itemCount: systemFiles.length,
        colorize: chalk.blue,
        barChar: 'S',
      },
      {
        key: 'prompt_library',
        label: 'Rules & prompts',
        shortLabel: 'P',
        tokenCount: promptLibraryTokens,
        itemCount: promptLibraryFiles.length,
        colorize: chalk.magenta,
        barChar: 'P',
      },
      {
        key: 'reference_docs',
        label: 'Reference docs',
        shortLabel: 'D',
        tokenCount: docsTokens,
        itemCount: referenceDocsFiles.length,
        colorize: chalk.green,
        barChar: 'D',
      },
      {
        key: 'chat_history',
        label: 'Chat history',
        shortLabel: 'H',
        tokenCount: historyTokens,
        itemCount: historyMessages.length,
        colorize: chalk.yellow,
        barChar: 'H',
      },
      {
        key: 'active_request',
        label: 'Active request',
        shortLabel: 'U',
        tokenCount: userMessageTokens,
        itemCount: latestUserMessage ? 1 : 0,
        colorize: chalk.white,
        barChar: 'U',
      },
    ];

    const segments = segmentDefinitions.map((segment) => {
      const shareOfInput = totalTokens <= 0 ? 0 : segment.tokenCount / totalTokens;
      const shareOfWindow = contextLimit.usableContextTokens <= 0 ? 0 : segment.tokenCount / contextLimit.usableContextTokens;
      const { note, severity } = this.describeContextSegment(segment.key, {
        tokenCount: segment.tokenCount,
        shareOfInput,
        itemCount: segment.itemCount,
        totalTokens,
        latestUserShare,
        turnDepthRatio,
      });

      return {
        ...segment,
        shareOfInput,
        shareOfWindow,
        note,
        severity,
      };
    });

    const drivers: ContextAnatomyDriver[] = [
      ...systemFiles.map((file) =>
        this.createContextAnatomyDriver(file.relativePath, file.tokenCount, totalTokens, contextLimit.usableContextTokens, 'Core', chalk.blue)
      ),
      ...promptLibraryFiles.map((file) =>
        this.createContextAnatomyDriver(
          file.relativePath,
          file.tokenCount,
          totalTokens,
          contextLimit.usableContextTokens,
          'Rules',
          chalk.magenta
        )
      ),
      ...referenceDocsFiles.map((file) =>
        this.createContextAnatomyDriver(
          file.relativePath,
          file.tokenCount,
          totalTokens,
          contextLimit.usableContextTokens,
          'Docs',
          chalk.green
        )
      ),
    ];

    if (historyTokens > 0) {
      drivers.push(
        this.createContextAnatomyDriver(
          `Chat history (${historyMessages.length} turns)`,
          historyTokens,
          totalTokens,
          contextLimit.usableContextTokens,
          'History',
          chalk.yellow
        )
      );
    }

    if (userMessageTokens > 0) {
      drivers.push(
        this.createContextAnatomyDriver(
          'Active user request',
          userMessageTokens,
          totalTokens,
          contextLimit.usableContextTokens,
          'Live ask',
          chalk.white
        )
      );
    }

    const topDrivers = drivers
      .slice()
      .sort((a, b) => b.tokenCount - a.tokenCount || a.label.localeCompare(b.label))
      .slice(0, 6);
    const dominantSegment = segments
      .slice()
      .sort((a, b) => b.tokenCount - a.tokenCount || a.label.localeCompare(b.label))[0];

    const lines: string[] = [];
    lines.push(chalk.bold('Budget'));
    lines.push(
      `Window load : ${this.renderStackedContextBar(
        segments,
        totalTokens,
        contextLimit.usableContextTokens
      )} ${this.formatTokenNumber(totalTokens)} / ${this.formatTokenNumber(contextLimit.usableContextTokens)} tok (${this.formatRatioPercent(
        budgetUtilization
      )})`
    );
    lines.push(
      `Payload mix : ${this.renderStackedContextBar(segments, totalTokens, Math.max(1, totalTokens), { fillWidth: true })}`
    );
    lines.push(chalk.dim(`Legend     : ${this.renderContextSegmentLegend()}`));
    lines.push(
      `Focus      : live ask ${this.formatRatioPercent(latestUserShare)} of payload | history drag ${this.formatRatioPercent(
        turnDepthRatio
      )} | ${
        dominantSegment && dominantSegment.tokenCount > 0
          ? `${dominantSegment.label.toLowerCase()} lead at ${this.formatRatioPercent(dominantSegment.shareOfInput)}`
          : 'no meaningful context loaded yet'
      }`
    );
    lines.push(
      `Headroom   : ${this.formatTokenNumber(usableHeadroom)} tok before reserve | ${this.formatTokenNumber(
        hardHeadroom
      )} tok before hard cap | ${this.renderContextBudgetStatus(budgetUtilization, overflowTokens)}`
    );
    lines.push(
      chalk.dim(
        `Model      : ${contextLimit.model} | reserve ${this.formatTokenNumber(
          contextLimit.bufferTokens
        )} tok kept for reply/autocompact`
      )
    );
    lines.push('');
    lines.push(chalk.bold('Segments'));
    lines.push(chalk.bold('Segment              Tokens    Input  Window  Focus'));
    lines.push(chalk.dim('-'.repeat(72)));
    segments.forEach((segment) => {
      lines.push(this.renderContextSegmentRow(segment));
    });
    lines.push('');
    lines.push(chalk.bold('Top Context Drivers'));
    if (topDrivers.length === 0) {
      lines.push(chalk.dim('No prompt assets or live conversation context detected yet.'));
    } else {
      lines.push(chalk.bold('Source                        Tokens   Share  Kind'));
      lines.push(chalk.dim('-'.repeat(60)));
      topDrivers.forEach((driver, index) => {
        lines.push(this.renderContextDriverRow(driver, index));
      });
    }

    const recommendations = this.buildContextAnatomyRecommendations({
      segments,
      drivers: topDrivers,
      totalTokens,
      usableHeadroom,
      overflowTokens,
      latestUserShare,
      turnDepthRatio,
    });

    const summary = [
      `budget: ${this.formatTokenNumber(totalTokens)} / ${this.formatTokenNumber(
        contextLimit.usableContextTokens
      )} tok (${this.formatRatioPercent(budgetUtilization)} of safe window)`,
      `headroom: ${this.formatTokenNumber(usableHeadroom)} tok before reserve`,
      `dominant: ${dominantSegment?.label ?? 'none'} (${this.formatRatioPercent(dominantSegment?.shareOfInput ?? 0)})`,
      `liveAsk: ${this.formatRatioPercent(latestUserShare)} | historyDrag: ${this.formatRatioPercent(turnDepthRatio)}`,
      ...recommendations.map((item) => `action: ${item}`),
    ];

    return { lines, recommendations, summary };
  }

  private renderContextAnatomyView(view: ContextAnatomyView): void {
    console.log(
      boxen(view.lines.join('\n'), {
        borderStyle: 'round',
        borderColor: 'cyan',
        title: ' Context Anatomy ',
        titleAlignment: 'left',
        padding: { top: 0, right: 1, bottom: 0, left: 1 },
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
      })
    );

    if (view.recommendations.length > 0) {
      console.log(chalk.cyan('  Actions'));
      view.recommendations.forEach((advice) => {
        console.log(chalk.cyan(`  - ${advice}`));
      });
    }
  }

  private classifyPromptAssetForAnatomy(file: {
    relativePath: string;
    categories: PromptAssetCategory[];
    tokenCount: number;
  }): 'system' | 'prompt_library' | 'reference_docs' {
    if (file.categories.includes('project-config') || file.categories.includes('system-prompt')) {
      return 'system';
    }
    if (file.categories.includes('prompt-file') || file.categories.includes('rules')) {
      return 'prompt_library';
    }
    return 'reference_docs';
  }

  private createContextAnatomyDriver(
    label: string,
    tokenCount: number,
    totalTokens: number,
    usableContextTokens: number,
    kind: string,
    colorize: (value: string) => string
  ): ContextAnatomyDriver {
    return {
      label,
      tokenCount,
      shareOfInput: totalTokens <= 0 ? 0 : tokenCount / totalTokens,
      shareOfWindow: usableContextTokens <= 0 ? 0 : tokenCount / usableContextTokens,
      kind,
      colorize,
    };
  }

  private describeContextSegment(
    key: ContextAnatomySegmentKey,
    stats: {
      tokenCount: number;
      shareOfInput: number;
      itemCount: number;
      totalTokens: number;
      latestUserShare: number;
      turnDepthRatio: number;
    }
  ): { note: string; severity: ContextActionSeverity } {
    if (stats.tokenCount <= 0) {
      switch (key) {
        case 'active_request':
          return { note: 'no live ask yet', severity: 'watch' };
        case 'chat_history':
          return { note: 'no prior turns', severity: 'stable' };
        default:
          return { note: 'not present', severity: 'stable' };
      }
    }

    switch (key) {
      case 'system':
        if (stats.shareOfInput >= 0.25 || stats.tokenCount >= 12000) {
          return { note: 'trim instruction sprawl', severity: 'trim' };
        }
        if (stats.shareOfInput >= 0.15) {
          return { note: 'keep stable, prune stale rules', severity: 'watch' };
        }
        return { note: 'stable prefix', severity: 'stable' };
      case 'prompt_library':
        if (stats.shareOfInput >= 0.25) {
          return { note: 'dedupe overlapping prompts', severity: 'trim' };
        }
        if (stats.shareOfInput >= 0.15) {
          return { note: 'watch for rule overlap', severity: 'watch' };
        }
        return { note: 'reusable prompt assets', severity: 'stable' };
      case 'reference_docs':
        if (stats.shareOfInput >= 0.25) {
          return { note: 'summarize before send', severity: 'trim' };
        }
        if (stats.shareOfInput >= 0.12) {
          return { note: 'attach narrower excerpts', severity: 'watch' };
        }
        return { note: 'cheap enough', severity: 'stable' };
      case 'chat_history':
        if (stats.turnDepthRatio > 0.85 || stats.shareOfInput >= 0.35) {
          return { note: 'roll up older turns', severity: 'trim' };
        }
        if (stats.shareOfInput >= 0.2) {
          return { note: 'watch drift and repeats', severity: 'watch' };
        }
        return { note: 'recent context only', severity: 'stable' };
      case 'active_request':
        if (stats.latestUserShare <= 0.08) {
          return { note: 'state output more clearly', severity: 'watch' };
        }
        return { note: 'goal is visible', severity: 'stable' };
      default:
        return { note: 'stable', severity: 'stable' };
    }
  }

  private buildContextAnatomyRecommendations(args: {
    segments: ContextAnatomySegment[];
    drivers: ContextAnatomyDriver[];
    totalTokens: number;
    usableHeadroom: number;
    overflowTokens: number;
    latestUserShare: number;
    turnDepthRatio: number;
  }): string[] {
    if (args.totalTokens <= 0) {
      return ['No prompt assets or live conversation context detected yet. Run /scan_prompt after you have a real request.'];
    }

    const recommendations: string[] = [];
    const largestTrimCandidate = args.segments
      .filter((segment) => segment.key !== 'active_request' && segment.tokenCount > 0)
      .sort((a, b) => b.tokenCount - a.tokenCount || a.label.localeCompare(b.label))[0];

    if (args.overflowTokens > 0) {
      recommendations.push(
        largestTrimCandidate
          ? `Cut at least ${this.formatTokenNumber(args.overflowTokens)} tok before the next send. Start with ${largestTrimCandidate.label.toLowerCase()} (${this.formatTokenNumber(
              largestTrimCandidate.tokenCount
            )} tok).`
          : `Cut at least ${this.formatTokenNumber(args.overflowTokens)} tok before the next send.`
      );
    } else if (args.usableHeadroom < 4000) {
      recommendations.push(
        `Only ${this.formatTokenNumber(args.usableHeadroom)} tok remain before the reserved buffer. Summarize history or docs before another long turn.`
      );
    } else {
      recommendations.push(
        `${this.formatTokenNumber(args.usableHeadroom)} tok of safe headroom remain, so the next gains are more about focus than raw overflow.`
      );
    }

    const dominantSegment = args.segments
      .filter((segment) => segment.key !== 'active_request' && segment.tokenCount > 0)
      .sort((a, b) => b.tokenCount - a.tokenCount || a.label.localeCompare(b.label))[0];

    if (dominantSegment && dominantSegment.shareOfInput >= 0.25) {
      const segmentAdvice: Record<Exclude<ContextAnatomySegmentKey, 'active_request'>, string> = {
        system: `Core instructions already take ${this.formatRatioPercent(
          dominantSegment.shareOfInput
        )} of the payload. Tighten base rules before stacking more context.`,
        prompt_library: `Rules and prompt assets take ${this.formatRatioPercent(
          dominantSegment.shareOfInput
        )} of the payload. Merge overlapping prompts before adding more.`,
        reference_docs: `Reference docs take ${this.formatRatioPercent(
          dominantSegment.shareOfInput
        )} of the payload. Quote only the sections needed for this task.`,
        chat_history: `Chat history takes ${this.formatRatioPercent(
          dominantSegment.shareOfInput
        )} of the payload. Replace older turns with a short recap.`,
      };
      if (dominantSegment.key !== 'active_request') {
        recommendations.push(segmentAdvice[dominantSegment.key]);
      }
    }

    if (args.turnDepthRatio > 0.85) {
      recommendations.push(
        `Older context dominates the window. The live ask is only ${this.formatRatioPercent(
          args.latestUserShare
        )} of the payload, so restate the goal and desired output format explicitly.`
      );
    } else if (args.latestUserShare > 0 && args.latestUserShare < 0.08) {
      recommendations.push(
        `The live ask is only ${this.formatRatioPercent(
          args.latestUserShare
        )} of the payload. Add a tighter goal line or checklist so it stays salient.`
      );
    }

    const largestDriver = args.drivers[0];
    if (largestDriver && largestDriver.shareOfInput >= 0.18 && largestDriver.kind !== 'Live ask') {
      recommendations.push(
        `Largest single context driver is ${largestDriver.label} (${this.formatTokenNumber(
          largestDriver.tokenCount
        )} tok). Make that cheaper before tuning smaller assets.`
      );
    }

    return Array.from(new Set(recommendations)).slice(0, 4);
  }

  private renderContextBudgetStatus(utilization: number, overflowTokens: number): string {
    if (overflowTokens > 0) {
      return chalk.red(`over safe budget by ${this.formatTokenNumber(overflowTokens)} tok`);
    }
    if (utilization >= 0.95) {
      return chalk.red('critical pressure');
    }
    if (utilization >= 0.85) {
      return chalk.yellow('warning pressure');
    }
    if (utilization >= 0.7) {
      return chalk.yellow('caution zone');
    }
    return chalk.green('healthy headroom');
  }

  private renderContextSegmentLegend(): string {
    return [
      `${chalk.blue('S')} core`,
      `${chalk.magenta('P')} prompts`,
      `${chalk.green('D')} docs`,
      `${chalk.yellow('H')} history`,
      `${chalk.white('U')} live ask`,
      `${chalk.dim('.')} free`,
    ].join(chalk.dim(' | '));
  }

  private renderContextSegmentRow(segment: ContextAnatomySegment): string {
    const labelText = segment.label.padEnd(20, ' ');
    const label = segment.tokenCount > 0 ? segment.colorize(labelText) : chalk.gray(labelText);
    const tokens = this.formatTokenNumber(segment.tokenCount).padStart(8, ' ');
    const inputShare = this.formatRatioPercent(segment.shareOfInput).padStart(6, ' ');
    const windowShare = this.formatRatioPercent(segment.shareOfWindow).padStart(6, ' ');
    const note = this.colorizeContextSeverity(segment.note, segment.severity);
    return `${label}  ${tokens}  ${chalk.dim(inputShare)}  ${chalk.dim(windowShare)}  ${note}`;
  }

  private renderContextDriverRow(driver: ContextAnatomyDriver, index: number): string {
    const rank = `${index + 1}.`.padStart(3, ' ');
    const source = this.truncateBlockName(driver.label, 28).padEnd(28, ' ');
    const tokens = this.formatTokenNumber(driver.tokenCount).padStart(8, ' ');
    const share = this.formatRatioPercent(driver.shareOfInput).padStart(6, ' ');
    return `${chalk.dim(rank)} ${driver.colorize(source)}  ${tokens}  ${chalk.dim(share)}  ${chalk.gray(driver.kind)}`;
  }

  private renderStackedContextBar(
    segments: ContextAnatomySegment[],
    totalTokens: number,
    denominator: number,
    options?: { fillWidth?: boolean }
  ): string {
    const width = CommandHandler.ANATOMY_BAR_WIDTH;
    if (width <= 0) {
      return '';
    }
    if (totalTokens <= 0 || denominator <= 0) {
      return chalk.dim('.'.repeat(width));
    }

    const normalizedFill = options?.fillWidth ? 1 : Math.max(0, Math.min(1, totalTokens / denominator));
    const filledWidth = normalizedFill > 0 ? Math.max(1, Math.round(normalizedFill * width)) : 0;
    const segmentWidths = this.allocateBarWidths(
      segments.map((segment) => segment.tokenCount),
      filledWidth
    );

    const filled = segments
      .map((segment, index) => {
        const count = segmentWidths[index] ?? 0;
        return count > 0 ? segment.colorize(segment.barChar.repeat(count)) : '';
      })
      .join('');
    const empty = chalk.dim('.'.repeat(Math.max(0, width - filledWidth)));
    const overflowSuffix =
      !options?.fillWidth && totalTokens > denominator
        ? chalk.red(` +${this.formatTokenNumber(totalTokens - denominator)} overflow`)
        : '';

    return `${filled}${empty}${overflowSuffix}`;
  }

  private allocateBarWidths(values: number[], totalWidth: number): number[] {
    if (totalWidth <= 0 || values.length === 0) {
      return values.map(() => 0);
    }

    const positiveValues = values.map((value) => Math.max(0, value));
    const total = positiveValues.reduce((sum, value) => sum + value, 0);
    if (total <= 0) {
      return values.map(() => 0);
    }

    const baseWidths = positiveValues.map((value) => Math.floor((value / total) * totalWidth));
    let assigned = baseWidths.reduce((sum, value) => sum + value, 0);
    const remainders = positiveValues
      .map((value, index) => ({
        index,
        remainder: (value / total) * totalWidth - baseWidths[index],
      }))
      .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

    let cursor = 0;
    while (assigned < totalWidth && cursor < remainders.length) {
      baseWidths[remainders[cursor].index] += 1;
      assigned += 1;
      cursor += 1;
    }

    return baseWidths;
  }

  private colorizeContextSeverity(value: string, severity: ContextActionSeverity): string {
    if (severity === 'trim') {
      return chalk.red(value);
    }
    if (severity === 'watch') {
      return chalk.yellow(value);
    }
    return chalk.green(value);
  }

  private formatRatioPercent(value: number): string {
    const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
    const percent = safeValue * 100;
    if (percent >= 10 || percent === 0) {
      return `${Math.round(percent)}%`;
    }
    return `${percent.toFixed(1)}%`;
  }

  private async resolveContextAnatomyLimit(): Promise<{
    model: string;
    contextWindowTokens: number;
    bufferTokens: number;
    usableContextTokens: number;
  }> {
    let model = 'unknown';
    try {
      const config = await this.configStore.getConfig();
      model = config.providers[config.activeProvider]?.model?.trim() || 'unknown';
    } catch {
      model = 'unknown';
    }
    const contextWindowTokens = this.estimateContextWindowTokens(model);
    const bufferTokens = Math.round(contextWindowTokens * CommandHandler.AUTOCOMPACT_BUFFER_RATIO);
    const usableContextTokens = Math.max(1, contextWindowTokens - bufferTokens);
    return { model, contextWindowTokens, bufferTokens, usableContextTokens };
  }

  private async resolveClaudeProjectDirectories(projectsRoot: string, rootPath: string): Promise<string[]> {
    const normalizedRoot = path.resolve(rootPath);
    const encodedExact = this.encodeClaudeProjectPath(normalizedRoot);
    const exactDir = path.join(projectsRoot, encodedExact);
    if (await this.pathExists(exactDir)) {
      return [exactDir];
    }

    const fallback: string[] = [];
    const baseName = path.basename(normalizedRoot).toLowerCase();
    if (!baseName) {
      return fallback;
    }

    try {
      const dirs = await fs.readdir(projectsRoot, { withFileTypes: true });
      for (const entry of dirs) {
        if (!entry.isDirectory()) {
          continue;
        }

        const name = entry.name.toLowerCase();
        if (name.endsWith(`-${baseName}`)) {
          fallback.push(path.join(projectsRoot, entry.name));
        }
      }
    } catch {
      return fallback;
    }

    return fallback.slice(0, 3);
  }

  private async listRecentJsonlFiles(
    projectDir: string,
    limit: number = CommandHandler.MAX_CLAUDE_HISTORY_FILES
  ): Promise<string[]> {
    try {
      const entries = await fs.readdir(projectDir, { withFileTypes: true });
      const files = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl'))
          .map(async (entry) => {
            const fullPath = path.join(projectDir, entry.name);
            try {
              const stat = await fs.stat(fullPath);
              return { fullPath, mtimeMs: stat.mtimeMs };
            } catch {
              return null;
            }
          })
      );

      return files
        .filter((item): item is { fullPath: string; mtimeMs: number } => item !== null)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, Math.max(1, limit))
        .map((item) => item.fullPath);
    } catch {
      return [];
    }
  }

  private async readChatTurnsFromJsonl(filePath: string): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch {
      return [];
    }

    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const result: Array<{ role: 'user' | 'assistant'; text: string }> = [];

    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        continue;
      }

      const item = this.extractClaudeChatItem(parsed);
      if (!item) {
        continue;
      }

      result.push(item);
      if (result.length >= CommandHandler.MAX_CLAUDE_HISTORY_ITEMS) {
        break;
      }
    }

    return result;
  }

  private async readChatItemsFromJsonl(filePath: string): Promise<string[]> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch {
      return [];
    }

    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const result: string[] = [];

    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        continue;
      }

      const item = this.extractClaudeChatItem(parsed);
      if (!item) {
        continue;
      }

      result.push(`[${item.role}] ${item.text}`);
      if (result.length >= CommandHandler.MAX_CLAUDE_HISTORY_ITEMS) {
        break;
      }
    }

    return result;
  }

  private extractClaudeChatItem(payload: unknown): { role: 'user' | 'assistant'; text: string } | null {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const record = payload as Record<string, unknown>;
    const topType = typeof record.type === 'string' ? record.type : '';
    const message = record.message && typeof record.message === 'object' ? (record.message as Record<string, unknown>) : null;
    const roleRaw = typeof message?.role === 'string' ? message.role : topType;
    const role = roleRaw === 'assistant' ? 'assistant' : roleRaw === 'user' ? 'user' : null;
    if (!role) {
      return null;
    }

    const content = this.extractClaudeContentText(message?.content);
    if (!content) {
      return null;
    }

    return { role, text: content };
  }

  private extractClaudeContentText(content: unknown): string {
    if (typeof content === 'string') {
      return this.compactHistoryText(content);
    }

    if (!Array.isArray(content)) {
      return '';
    }

    const segments: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      const record = item as Record<string, unknown>;
      const type = typeof record.type === 'string' ? record.type : '';

      if (type === 'text' && typeof record.text === 'string') {
        segments.push(record.text);
        continue;
      }

      if (type === 'tool_result' && typeof record.content === 'string') {
        segments.push(record.content);
        continue;
      }

      if (typeof record.content === 'string') {
        segments.push(record.content);
      }
    }

    return this.compactHistoryText(segments.join('\n'));
  }

  private compactHistoryText(input: string): string {
    const normalized = input.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!normalized) {
      return '';
    }

    const maxChars = 900;
    if (normalized.length <= maxChars) {
      return normalized;
    }
    return `${normalized.slice(0, maxChars)}...(truncated)`;
  }

  private encodeClaudeProjectPath(inputPath: string): string {
    const resolved = path.resolve(inputPath);
    // Use a collision-safe encoding: percent-encode separators so that
    // "/foo/bar" and "/foo-bar" can never produce the same output.
    return resolved.replace(/[\\/:]/g, (ch) =>
      ch === '\\' ? '%5C' : ch === '/' ? '%2F' : '%3A'
    );
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private truncateBlockName(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }
    const fileName = path.basename(value);
    if (fileName.length <= maxLength) {
      return fileName;
    }
    if (maxLength <= 3) {
      return fileName.slice(0, maxLength);
    }
    return `${fileName.slice(0, maxLength - 3)}...`;
  }

  private createAnatomyBucket(
    name: string,
    tokenCount: number,
    denominator: number,
    colorize: (value: string) => string,
    options?: { fillChar?: '█' | '▓'; warning?: boolean }
  ): AnatomyBucket {
    return {
      name,
      tokenCount,
      percent: denominator <= 0 ? 0 : Math.round((tokenCount / denominator) * 100),
      colorize,
      fillChar: options?.fillChar,
      warning: options?.warning,
    };
  }

  private renderAnatomyRow(bucket: AnatomyBucket): string {
    const fillChar = bucket.fillChar ?? '█';
    const barLen = bucket.tokenCount > 0 ? Math.max(1, Math.round((bucket.percent / 100) * CommandHandler.ANATOMY_BAR_WIDTH)) : 0;
    const filled = barLen > 0 ? bucket.colorize(fillChar.repeat(barLen)) : '';
    const empty = chalk.dim('░'.repeat(Math.max(0, CommandHandler.ANATOMY_BAR_WIDTH - barLen)));
    const bar = `${filled}${empty}`;
    const label = bucket.name.padEnd(14, ' ');
    const tokenText = this.formatTokenNumber(bucket.tokenCount).padStart(9, ' ');
    const percentText = bucket.warning ? ' WARN' : `${bucket.percent}%`.padStart(5, ' ');
    const percentStyled = bucket.warning ? chalk.red(percentText) : chalk.dim(percentText);
    const labelStyled = bucket.warning ? chalk.red(label) : chalk.gray(label);

    return `${labelStyled}  ${tokenText} tok  ${percentStyled}  ${bar}`;
  }

  private truncatePathForAnatomy(relativePath: string): string {
    if (relativePath.length <= 28) {
      return relativePath;
    }
    return `...${relativePath.slice(-25)}`;
  }

  private recordCommandData(command: string, data: string): void {
    this.onCommandDataGenerated(command, data);
  }
}
