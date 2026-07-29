/**
 * Re-export of cross-channel outbound media helpers.
 *
 * The `<attach path="..."/>` marker convention and file-kind classification
 * were extracted to `core/channels/outbound-media.ts` so feishu (and future
 * wecom) share the same protocol. Existing `weixin/` callers keep importing
 * from `./outbound-media.js`; new code should import from
 * `core/channels/outbound-media.js` directly.
 */
export {
  classifyByExt,
  extractOutboundMedia,
} from '../channels/outbound-media.js';
