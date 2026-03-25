export interface MessageRenderMetadata {
  appendix?: string;
  modelLabel?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  collapsed: boolean;
  renderMetadata?: MessageRenderMetadata;
}

export interface TranscriptOptions {
  maxMessages?: number;
  includeSystem?: boolean;
  maxChars?: number;
}

export class ConversationManager {
  private messages: Message[] = [];
  private messageIdCounter: number = 0;

  addMessage(role: Message['role'], content: string, renderMetadata?: MessageRenderMetadata): Message {
    const message: Message = {
      id: `msg_${++this.messageIdCounter}`,
      role,
      content,
      timestamp: new Date(),
      collapsed: false,
      renderMetadata,
    };

    this.messages.push(message);
    return message;
  }

  getMessages(): Message[] {
    return this.messages;
  }

  getMessageById(id: string): Message | undefined {
    return this.messages.find(msg => msg.id === id);
  }

  toggleCollapse(id: string): boolean {
    const message = this.getMessageById(id);
    if (message) {
      message.collapsed = !message.collapsed;
      return true;
    }
    return false;
  }

  collapse(id: string): boolean {
    const message = this.getMessageById(id);
    if (message) {
      message.collapsed = true;
      return true;
    }
    return false;
  }

  expand(id: string): boolean {
    const message = this.getMessageById(id);
    if (message) {
      message.collapsed = false;
      return true;
    }
    return false;
  }

  collapseAll(): void {
    this.messages.forEach(msg => msg.collapsed = true);
  }

  expandAll(): void {
    this.messages.forEach(msg => msg.collapsed = false);
  }

  clear(): void {
    this.messages = [];
    this.messageIdCounter = 0;
  }

  getLastMessage(): Message | undefined {
    return this.messages[this.messages.length - 1];
  }

  buildTranscript(options?: TranscriptOptions): string {
    const maxMessages = Math.max(1, options?.maxMessages ?? 120);
    const includeSystem = options?.includeSystem ?? false;
    const maxChars = Math.max(500, options?.maxChars ?? 32000);

    const filtered = this.messages.filter((message) => includeSystem || message.role !== 'system');
    const selected = filtered.slice(-maxMessages);
    const lines: string[] = [];

    for (const message of selected) {
      const timestamp = message.timestamp.toISOString();
      const content = message.content.replace(/\r\n/g, '\n').trim();
      lines.push(`[${timestamp}] ${message.role.toUpperCase()} (${message.id})`);
      lines.push(content || '(empty)');
      lines.push('');
    }

    const transcript = lines.join('\n').trim();
    if (transcript.length <= maxChars) {
      return transcript;
    }

    return `...(truncated)\n${transcript.slice(transcript.length - maxChars)}`;
  }
}
