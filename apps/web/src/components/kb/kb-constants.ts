/** Max selection length (chars) sent to QA via "就此提问". */
export const MAX_ASK_SELECTION = 50 * 1024;

/**
 * 页内发布 tab 的固定 id。tab store 本就 per-vault（createTabsStore(vaultId)），
 * 固定 id 天然保证每库单例：重复点「发布到资源库」只会激活已有 tab。
 */
export const PUBLISH_TAB_ID = 'publish';

/**
 * 页内图谱标签的固定 id。与 publish 同理：tab store 本就 per-vault，固定 id 天然
 * 保证每库单例——重复点 NavRail「图谱」只会激活已有图谱标签，不重复开。
 */
export const GRAPH_TAB_ID = 'graph';

/**
 * 外部素材根的挂载目录名：`<vault>/external/<label>` 是真实目录链接，指向
 * vault 之外的文件夹（daemon 侧见 core/external-roots.ts）。
 */
export const EXTERNAL_MOUNT_DIR = 'external';

/**
 * 路径是否位于外部素材挂载区（`external` 本身或其后代）。
 *
 * 这里的只读判定必须与 daemon 的 write 边界一致：daemon 用 realpath 判定
 * 写入点是否落在 vault 内（`assertWriteWithinVault`），凡是解析到 vault 外的
 * 写入一律拒绝。UI 用路径前缀判定只是保守近似——宁可把 `external/` 整个
 * 子树都当作只读，也不给用户一个必然失败的写入入口。
 */
export function isExternalPath(relPath: string): boolean {
  return relPath === EXTERNAL_MOUNT_DIR || relPath.startsWith(`${EXTERNAL_MOUNT_DIR}/`);
}
