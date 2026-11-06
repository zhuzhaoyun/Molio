import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { chatRuntimeStore } from './chatRuntimeStore.ts';

/**
 * chatRuntimeStore — 聊天 runtime/模型选择的单一事实源。
 *
 * 核心行为（用户拍板的作用域）：
 *  - 切模型对下一条消息即时生效（createRun 读快照）；
 *  - 按 runtime 记住常用模型（localStorage 持久化），切回该 runtime 自动恢复；
 *  - 切 runtime 不携带上一个 runtime 的模型；
 *  - model=null 表示「跟随 CLI 默认」，不落盘。
 */

type StorageBacking = Map<string, string>;

function installFakeStorage(): StorageBacking {
  const backing: StorageBacking = new Map();
  const storage = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => { backing.set(k, String(v)); },
    removeItem: (k: string) => { backing.delete(k); },
    clear: () => { backing.clear(); },
  };
  (globalThis as { localStorage?: unknown }).localStorage = storage;
  return backing;
}

function uninstallFakeStorage() {
  delete (globalThis as { localStorage?: unknown }).localStorage;
}

describe('chatRuntimeStore', () => {
  beforeEach(() => {
    installFakeStorage();
    // 复位模块级状态：agentId=null（model 随之为 null），fake storage 已是全新 Map
    chatRuntimeStore.setAgentId(null);
  });

  afterEach(() => {
    uninstallFakeStorage();
  });

  it('setModel 更新当前模型并通知订阅者', () => {
    chatRuntimeStore.setAgentId('claude');
    let notified = 0;
    const unsub = chatRuntimeStore.subscribe(() => { notified += 1; });

    chatRuntimeStore.setModel('sonnet');

    assert.equal(chatRuntimeStore.getState().model, 'sonnet');
    assert.equal(notified, 1);
    unsub();
  });

  it('setModel 按 runtime 持久化到 localStorage', () => {
    chatRuntimeStore.setAgentId('claude');
    chatRuntimeStore.setModel('sonnet');

    assert.equal(globalThis.localStorage.getItem('molio.chatModel.claude'), 'sonnet');
  });

  it('切 runtime 不携带上一个 runtime 的模型', () => {
    chatRuntimeStore.setAgentId('claude');
    chatRuntimeStore.setModel('sonnet');

    chatRuntimeStore.setAgentId('codex');

    assert.equal(chatRuntimeStore.getState().model, null);
  });

  it('切回 runtime 时恢复该 runtime 记住的常用模型', () => {
    chatRuntimeStore.setAgentId('claude');
    chatRuntimeStore.setModel('sonnet');
    chatRuntimeStore.setAgentId('codex');
    chatRuntimeStore.setModel('qwen3-max');

    chatRuntimeStore.setAgentId('claude');
    assert.equal(chatRuntimeStore.getState().model, 'sonnet');

    chatRuntimeStore.setAgentId('codex');
    assert.equal(chatRuntimeStore.getState().model, 'qwen3-max');
  });

  it('setModel(null) 表示跟随 CLI 默认，并清除持久化记录', () => {
    chatRuntimeStore.setAgentId('claude');
    chatRuntimeStore.setModel('sonnet');
    chatRuntimeStore.setModel(null);

    assert.equal(chatRuntimeStore.getState().model, null);
    assert.equal(globalThis.localStorage.getItem('molio.chatModel.claude'), null);

    // 切走再切回，仍是「跟随默认」
    chatRuntimeStore.setAgentId('codex');
    chatRuntimeStore.setAgentId('claude');
    assert.equal(chatRuntimeStore.getState().model, null);
  });

  it('无 localStorage 环境（如 node 单测/降级）下一切操作安全，仅内存态', () => {
    uninstallFakeStorage();
    chatRuntimeStore.setAgentId('claude');
    chatRuntimeStore.setModel('sonnet');
    assert.equal(chatRuntimeStore.getState().model, 'sonnet');

    chatRuntimeStore.setAgentId('codex');
    chatRuntimeStore.setAgentId('claude');
    // 无持久化 → 记不住，回到默认
    assert.equal(chatRuntimeStore.getState().model, null);
  });

  it('setAgentId 相同值不重复通知', () => {
    chatRuntimeStore.setAgentId('claude');
    let notified = 0;
    const unsub = chatRuntimeStore.subscribe(() => { notified += 1; });

    chatRuntimeStore.setAgentId('claude');
    assert.equal(notified, 0);
    unsub();
  });
});
