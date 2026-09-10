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
 * `hasRoots` 是该 vault 是否注册了**至少一个**外部素材根。这个前提不能省：
 * 挂载区靠的是 `external/` 这个名字，而名字本身没有任何特殊性——一个从没挂载
 * 过外部素材的 vault 完全可以自己有一个 `external/` 文件夹，那种情况下它必须
 * 和本特性引入前完全一样（可新建 / 可重命名 / 可编辑）。daemon 侧同样是宽松的：
 * 没有 root 注册时 `external/` 走普通 vault 解析。所以只读判定 = 「有挂载」且
 * 「路径落在挂载区」。
 *
 * 有挂载时这里的判定必须与 daemon 的 write 边界一致：daemon 用 realpath 判定
 * 写入点是否落在 vault 内（`assertWriteWithinVault`），凡是解析到 vault 外的
 * 写入一律拒绝。UI 用路径前缀判定只是保守近似——宁可把 `external/` 整个
 * 子树都当作只读，也不给用户一个必然失败的写入入口。
 *
 * 分隔符归一化与 daemon 的 `isExternalMountPath`（core/external-roots.ts）保持
 * 逐字一致：现有调用点传的都是树里来的正斜杠路径，但两个函数在注释里互为镜像，
 * 不能只在一侧兼容 Windows 反斜杠。
 */
export function isExternalPath(relPath: string, hasRoots: boolean): boolean {
  if (!hasRoots) return false;
  const p = relPath.replace(/\\/g, '/');
  return p === EXTERNAL_MOUNT_DIR || p.startsWith(`${EXTERNAL_MOUNT_DIR}/`);
}
