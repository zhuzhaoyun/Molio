// Re-export the shared dispatcher + types so existing callers can keep
// importing from 'weixin/dispatcher'. New code should import from
// 'core/channels/dispatcher' directly.
//
// The weixin role frame (收件/入库/问答/文件回传 mechanics + wiki-query routing)
// is delivered as a MESSAGE PREPEND on fresh spawns — `buildWeixinFrameMessage`
// in ./message.ts, wired by WeixinService as the shared dispatcher's
// `frameFirstTurn` dep — NOT via --append-system-prompt-file: the CLI silently
// drops that flag in some environments (A/B/C probe verified the appended frame
// never reached the model), whereas a message prepend always lands. Weixin is
// a dedicated channel the daemon fully controls, so the prepend carries no
// cross-context role-lock risk.
export {
  ChannelDispatcher as WeixinRunDispatcher,
  type ChannelDispatcherDeps as DispatchDeps,
  type DispatchRequest,
} from '../channels/dispatcher.js';
