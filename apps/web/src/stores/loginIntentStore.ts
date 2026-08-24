/**
 * Login intent store — bridge between resource actions and the account modal.
 *
 * 资源下载/购买统一要求登录（门槛收口在 resourceAction.ts）：未登录时
 * `requestLogin(resume)` 挂起一个意图；账号模态框（NavRail 挂载）订阅后打开并
 * 直达 login 视图，登录成功回调 `resume` 续接原动作（自动续接下载/支付，
 * 不强迫用户再点一次），用户取消则丢弃。
 *
 * 模块级状态，同 vaultStore / authStore 模式；组件只经 NavRail 消费，
 * 其他地方只用 requestLogin，不直接渲染。
 */

type Listener = () => void;

let pendingResume: (() => void) | null = null;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

export const loginIntentStore = {
  subscribe(cb: Listener) {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },

  /** 是否有待处理的登录意图 */
  hasPending(): boolean {
    return pendingResume !== null;
  },

  /** 取出并清空待处理意图的续接回调（账号模态框消费） */
  consume(): (() => void) | null {
    const r = pendingResume;
    if (pendingResume !== null) {
      pendingResume = null;
      emit();
    }
    return r;
  },

  /** 请求登录：登录成功后执行 resume（续接被门槛拦下的动作） */
  requestLogin(resume: () => void): void {
    pendingResume = resume;
    emit();
  },
};
