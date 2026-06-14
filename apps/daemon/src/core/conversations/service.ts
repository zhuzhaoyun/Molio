import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ChatMessage, Conversation } from '@molio/contracts';
import {
  createExternalConversation,
  getConversationByExternalSession,
  listMessages,
  upsertMessage,
} from '../db.js';

export interface ExternalConversationKey {
  channelType: string;
  externalSessionId: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export class ConversationService {
  constructor(private readonly db: Database.Database) {}

  getOrCreateExternalConversation(input: ExternalConversationKey): Conversation {
    const existing = getConversationByExternalSession(
      this.db,
      input.channelType,
      input.externalSessionId,
    );
    if (existing) return existing;
    return createExternalConversation(this.db, input);
  }

  listHistory(conversationId: string): ChatMessage[] {
    return listMessages(this.db, conversationId);
  }

  appendUserMessage(conversationId: string, content: string): ChatMessage {
    const message: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content,
      timestamp: Date.now(),
    };
    upsertMessage(this.db, conversationId, message);
    return message;
  }

  appendAssistantMessage(
    conversationId: string,
    content: string,
    options: { agentId?: string; runId?: string } = {},
  ): ChatMessage {
    const message: ChatMessage = {
      id: randomUUID(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
      agentId: options.agentId,
      runId: options.runId,
    };
    upsertMessage(this.db, conversationId, message);
    return message;
  }
}
