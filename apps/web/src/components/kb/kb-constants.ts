/** Max selection length (chars) sent to QA via "就此提问". */
export const MAX_ASK_SELECTION = 50 * 1024;

/**
 * 页内发布 tab 的固定 id。tab store 本就 per-vault（createTabsStore(vaultId)），
 * 固定 id 天然保证每库单例：重复点「发布到资源库」只会激活已有 tab。
 */
export const PUBLISH_TAB_ID = 'publish';
