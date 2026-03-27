import chalk from 'chalk';

export class Spinner {
  private frames = ['-', '\\', '|', '/'];
  private currentFrame = 0;
  private interval: NodeJS.Timeout | null = null;
  private message = '';
  private startedAt = 0;

  start(message: string): void {
    this.message = message;
    this.currentFrame = 0;
    this.startedAt = Date.now();

    this.render();

    this.interval = setInterval(() => {
      this.render();
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
    }, 80);
  }

  stop(finalMessage?: string): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    process.stdout.write('\r\x1b[K');

    if (finalMessage) {
      console.log(chalk.dim('  | ') + chalk.green('+') + ' ' + chalk.gray(finalMessage));
    }
  }

  fail(errorMessage: string): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    process.stdout.write('\r\x1b[K');
    console.log(chalk.dim('  | ') + chalk.red('x') + ' ' + chalk.red(errorMessage));
  }

  private render(): void {
    const elapsed = this.formatElapsed(Date.now() - this.startedAt);
    process.stdout.write(
      '\r' +
        chalk.dim('  | ') +
        chalk.cyan(this.frames[this.currentFrame]) +
        ' ' +
        chalk.gray(`${this.message} (${elapsed})`)
    );
  }

  private formatElapsed(elapsedMs: number): string {
    const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    if (minutes === 0) {
      return `${seconds}s`;
    }

    return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  }
}
