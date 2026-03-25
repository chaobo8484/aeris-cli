export interface Command {
  name: string;
  description: string;
  aliases?: string[];
  usage?: string;
}

export class CommandRegistry {
  private commands: Map<string, Command> = new Map();

  constructor() {
    this.registerDefaultCommands();
  }

  private registerDefaultCommands(): void {
    this.register({ name: 'help', description: 'Show help information', usage: '/help' });
    this.register({ name: 'clear', description: 'Clear conversation history', usage: '/clear' });
    this.register({ name: 'history', description: 'Show all conversation messages', usage: '/history' });
    this.register({ name: 'collapse', description: 'Collapse messages', usage: '/collapse [id|all]' });
    this.register({ name: 'expand', description: 'Expand messages', usage: '/expand [id|all]' });
    this.register({ name: 'exit', description: 'Exit the program', aliases: ['quit'], usage: '/exit' });
    this.register({ name: 'analyze', description: 'Analyze conversation pattern', usage: '/analyze' });
    this.register({ name: 'export', description: 'Export conversation history', usage: '/export [filename]' });
    this.register({
      name: 'model',
      description: 'Switch the active API model for this CLI session',
      usage: '/model [model-name|clear]',
    });
    this.register({
      name: 'provider',
      description: 'Switch the active LLM provider',
      usage: '/provider [claude|openrouter]',
    });
    this.register({
      name: 'trustpath',
      description: 'Trust the current working directory',
      aliases: ['trust'],
      usage: '/trustpath',
    });
    this.register({
      name: 'trustcheck',
      description: 'Quickly check whether current directory is trusted',
      aliases: ['truststatus'],
      usage: '/trustcheck',
    });
    this.register({
      name: 'skills',
      description: 'Scan local SKILL.md files and render a Skills overview page',
      aliases: ['scan_skills', 'skillscan'],
      usage: '/skills [path]',
    });
    this.register({
      name: 'scan_prompt',
      description: 'Scan prompt/rules/agent assets in the current project',
      aliases: ['scanprompt'],
      usage: '/scan_prompt',
    });
    this.register({
      name: 'scan_tokens',
      description: 'Parse Claude JSONL token structures and render token analytics',
      aliases: ['scantokens', 'tokenscan'],
      usage: '/scan_tokens [current|all|path]',
    });
    this.register({
      name: 'context_health',
      description: 'Check context window health from Claude JSONL usage records',
      aliases: ['ctxhealth', 'contexthealth'],
      usage: '/context_health [current|all|path]',
    });
    this.register({
      name: 'context_noise',
      description: 'Detect noisy context from Claude JSONL sessions and suggest delete/keep',
      aliases: ['ctxnoise', 'contextnoise'],
      usage: '/context_noise [current|all|path]',
    });
    this.register({
      name: 'todo_granularity',
      description: 'Analyze todo granularity against Claude context/token usage',
      aliases: ['todograin', 'todocontext'],
      usage: '/todo_granularity [current|all|path]',
    });
    this.register({
      name: 'projectcontext',
      description: 'Toggle project context injection for model requests',
      aliases: ['projectctx'],
      usage: '/projectcontext [on|off|status]',
    });
  }

  register(command: Command): void {
    this.commands.set(command.name, command);
    if (command.aliases) {
      command.aliases.forEach((alias) => {
        this.commands.set(alias, command);
      });
    }
  }

  getCommand(name: string): Command | undefined {
    return this.commands.get(name);
  }

  getAllCommands(): Command[] {
    const uniqueCommands = new Map<string, Command>();
    this.commands.forEach((cmd, key) => {
      if (key === cmd.name) {
        uniqueCommands.set(cmd.name, cmd);
      }
    });
    return Array.from(uniqueCommands.values());
  }

  searchCommands(query: string): Command[] {
    const lowerQuery = query.toLowerCase();
    return this.getAllCommands().filter(
      (cmd) => cmd.name.toLowerCase().startsWith(lowerQuery) || cmd.description.toLowerCase().includes(lowerQuery)
    );
  }

  getCommandNames(): string[] {
    return this.getAllCommands().map((cmd) => cmd.name);
  }

  findCommandsByPrefix(query: string): Command[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return [];
    }

    const matched = new Map<string, Command>();
    this.commands.forEach((command, key) => {
      if (key.toLowerCase().startsWith(normalized)) {
        matched.set(command.name, command);
      }
    });

    return Array.from(matched.values());
  }
}
