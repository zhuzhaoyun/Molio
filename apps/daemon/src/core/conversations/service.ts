import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ChatMessage, Conversation } from '@molio/contracts';
import {
  closeConversation,
  createDesktopConversation,
  createExternalConversation,
  getConversation,
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

  createDesktopConversation(title?: string, vaultId?: string | null, vaultName?: string | null): Conversation {
    return createDesktopConversation(this.db, title, vaultId, vaultName);
  }

  getConversation(conversationId: string): Conversation | null {
    return getConversation(this.db, conversationId);
  }

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

  appendMessage(conversationId: string, message: ChatMessage): ChatMessage {
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

  /**
   * Close the current external session conversation so the next message
   * creates a fresh one. The old conversation is preserved for history viewing.
   * @returns true if a conversation was closed, false if none existed
   */
  closeExternalSession(channelType: string, externalSessionId: string): boolean {
    const existing = getConversationByExternalSession(this.db, channelType, externalSessionId);
    if (!existing) return false;
    closeConversation(this.db, existing.id);
    return true;
  }
}
