/** vault-resolver：id 精确 / name 忽略大小写 / 歧义 / 缺省 active / 无 active / agent 选择。 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { resolveAgentId, resolveVault } from '../src/vault-resolver.js';
import { expectCliError, startHarness, type Harness } from './helpers.js';

describe('vault-resolver', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await h.teardown();
  });

  it('按 id 精确匹配', async () => {
    const vault = await resolveVault(h.client, 'v2');
    assert.equal(vault.name, 'Notes');
  });

  it('按名称忽略大小写匹配', async () => {
    const vault = await resolveVault(h.client, 'NOTES');
    assert.equal(vault.id, 'v2');
  });

  it('名称歧义 → CliError(2) 并列出候选', async () => {
    h.daemon.vaults.push({
      id: 'v3',
      name: 'notes',
      path: '/vaults/other',
      fileCount: 0,
      createdAt: 3,
    });
    const message = await expectCliError(() => resolveVault(h.client, 'Notes'), 2);
    assert.match(message, /多个匹配/);
    assert.match(message, /v2/);
    assert.match(message, /v3/);
    h.daemon.vaults.pop();
  });

  it('未知名称 → CliError(2) 并列出全部可用库', async () => {
    const message = await expectCliError(() => resolveVault(h.client, '不存在'), 2);
    assert.match(message, /未找到知识库/);
    assert.match(message, /工作库/);
  });

  it('缺省 → active vault', async () => {
    const vault = await resolveVault(h.client);
    assert.equal(vault.id, 'v1');
  });

  it('空串参数视同缺省', async () => {
    const vault = await resolveVault(h.client, '  ');
    assert.equal(vault.id, 'v1');
  });

  it('无 active vault 且未指定 → CliError(2)', async () => {
    h.daemon.activeVaultId = null;
    const message = await expectCliError(() => resolveVault(h.client), 2);
    assert.match(message, /没有打开的知识库/);
    h.daemon.activeVaultId = 'v1';
  });

  it('agent: 显式参数直通（不查列表）', async () => {
    const id = await resolveAgentId(h.client, ' custom-agent ');
    assert.equal(id, 'custom-agent');
  });

  it('agent: 缺省取第一个 available', async () => {
    const id = await resolveAgentId(h.client);
    assert.equal(id, 'claude-code');
  });

  it('agent: 无可用 runtime → CliError(5)', async () => {
    const saved = h.daemon.agents;
    h.daemon.agents = [{ ...saved[0]!, available: false }];
    const message = await expectCliError(() => resolveAgentId(h.client), 5);
    assert.match(message, /没有检测到可用的 AI runtime/);
    h.daemon.agents = saved;
  });
});
