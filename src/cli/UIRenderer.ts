import chalk from 'chalk';
import { ConversationManager, Message } from './ConversationManager.js';

export class UIRenderer {
  private conversationManager: ConversationManager;
  private readonly BORDER_COLOR = chalk.dim;
  private readonly USER_COLOR = chalk.white;
  private readonly ASSISTANT_COLOR = chalk.cyan;
  private readonly GUTTER = '|';

  constructor(conversationManager: ConversationManager) {
    this.conversationManager = conversationManager;
  }

  renderAllMessages(): void {
    console.clear();
    const messages = this.conversationManager.getMessages();

    messages.forEach((msg) => {
      this.renderMessage(msg);
    });
  }

  renderLastMessage(): void {
    const lastMessage = this.conversationManager.getLastMessage();
    if (lastMessage) {
      this.renderMessage(lastMessage);
    }
  }

  private renderMessage(message: Message): void {
    const roleLabel =
      message.role === 'assistant' && message.renderMetadata?.modelLabel?.trim()
        ? `Odradek(${message.renderMetadata.modelLabel.trim()})`
        : message.role === 'user'
          ? 'You'
          : 'Odradek';
    const timestamp = this.formatTimestamp(message.timestamp);
    const meta = this.BORDER_COLOR(` - ${timestamp} - ${message.id}`);

    console.log('');

    if (message.role === 'user') {
      console.log('  ' + this.USER_COLOR.bold(roleLabel) + meta);
    } else {
      console.log('  ' + this.ASSISTANT_COLOR.bold(roleLabel) + meta);
    }

    if (message.collapsed) {
      const collapsedText = `[collapsed] ${this.truncateContent(message.content)}`;
      if (message.role === 'user') {
        console.log(this.BORDER_COLOR(`  ${this.GUTTER} `) + chalk.black.bgWhite(` ${collapsedText} `));
      } else {
        console.log(this.BORDER_COLOR(`  ${this.GUTTER} `) + chalk.dim('[collapsed] ') + chalk.gray(this.truncateContent(message.content)));
      }
    } else {
      this.renderContent(message.content, message.role);
      if (message.role === 'assistant' && message.renderMetadata?.appendix?.trim()) {
        console.log(this.BORDER_COLOR(`  ${this.GUTTER} `) + chalk.dim(''));
        this.renderAppendix(message.renderMetadata.appendix);
      }
    }
  }

  private renderContent(content: string, role: Message['role']): void {
    const lines = content.split('\n');
    const maxWidth = Math.max(20, (process.stdout.columns ?? 80) - 4);
    lines.forEach((line) => {
      const wrapped = this.wrapLine(line, maxWidth);
      wrapped.forEach((segment) => {
        if (role === 'user') {
          console.log(this.BORDER_COLOR(`  ${this.GUTTER} `) + chalk.black.bgWhite(` ${segment} `));
          return;
        }
        console.log(this.BORDER_COLOR(`  ${this.GUTTER} `) + segment);
      });
    });
  }

  private renderAppendix(appendix: string): void {
    const lines = appendix.split('\n');
    const maxWidth = Math.max(20, (process.stdout.columns ?? 80) - 4);
    lines.forEach((line) => {
      const wrapped = this.wrapLine(line, maxWidth);
      wrapped.forEach((segment) => {
        console.log(this.BORDER_COLOR(`  ${this.GUTTER} `) + chalk.dim(segment));
      });
    });
  }

  private truncateContent(content: string, maxLength = 60): string {
    const singleLine = content.replace(/\n/g, ' ');
    if (singleLine.length <= maxLength) {
      return singleLine;
    }
    return singleLine.substring(0, maxLength) + '...';
  }

  private wrapLine(line: string, maxWidth: number): string[] {
    if (line.length <= maxWidth) {
      return [line];
    }

    const words = line.split(' ');
    const lines: string[] = [];
    let current = '';

    words.forEach((word) => {
      if (word.length > maxWidth) {
        if (current.length > 0) {
          lines.push(current);
          current = '';
        }

        for (let i = 0; i < word.length; i += maxWidth) {
          const chunk = word.slice(i, i + maxWidth);
          if (chunk.length === maxWidth) {
            lines.push(chunk);
          } else {
            current = chunk;
          }
        }
        return;
      }

      const next = current.length === 0 ? word : `${current} ${word}`;
      if (next.length > maxWidth) {
        if (current.length > 0) {
          lines.push(current);
          current = word;
        }
      } else {
        current = next;
      }
    });

    if (current.length > 0) {
      lines.push(current);
    }

    return lines;
  }

  private formatTimestamp(date: Date): string {
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  }

  renderError(message: string): void {
    console.log('');
    console.log(chalk.dim(`  ${this.GUTTER} `) + chalk.red('x ') + chalk.red(message));
  }

  renderSuccess(message: string): void {
    console.log('');
    console.log(chalk.dim(`  ${this.GUTTER} `) + chalk.green('+ ') + message);
  }

  renderInfo(message: string): void {
    console.log('');
    console.log(chalk.dim(`  ${this.GUTTER} `) + chalk.cyan('i ') + chalk.gray(message));
  }

  renderWarning(message: string): void {
    console.log('');
    console.log(chalk.dim(`  ${this.GUTTER} `) + chalk.yellow('! ') + chalk.yellow(message));
  }

  renderDivider(): void {
    console.log('');
    console.log(chalk.dim('  ------------------------------------------------------------'));
    console.log('');
  }

  renderSection(title: string): void {
    console.log('');
    console.log(chalk.bold('  ' + title));
  }

  renderSectionEnd(): void {
    console.log('');
  }

  renderCommandInvocation(command: string): void {
    console.log('');
    const highlighted = chalk.black.bgWhite(` ❯ ${command} `);
    console.log(`  ${highlighted}`);
  }

  renderCommandResult(message: string): void {
    console.log(chalk.dim(`  ⎿  ${message}`));
  }
}

