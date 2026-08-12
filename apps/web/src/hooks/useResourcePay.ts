/**
 * 资源购买支付状态机 —— 直连 pay.molio.cn（已验证 CORS 放行 *）。
 *
 * 流程与官网 apps/landing-page/pay.js 1:1：
 *   GET /pay?id= 下单 → 渲染二维码 → 每 3s 轮询 GET /order → SUCCESS 后
 *   GET /deliver 拿 presign 下载链接（1 小时有效）。
 *
 * 行为细节对齐 pay.js：单次轮询失败静默继续；deliver 失败提示凭订单号联系；
 * 关闭/卸载清理 interval。另用语义化 errorKind 交由组件做 i18n 文案渲染。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { PAY_BASE, type MolioResource } from '../data/resources';

export type PayPhase =
  | 'idle'      // 弹窗未打开
  | 'creating'  // 正在下单
  | 'waiting'   // 二维码已出，等待扫码（轮询中）
  | 'delivering'// 支付成功，换取下载链接
  | 'success'   // 下载链接就绪
  | 'error';

export type PayErrorKind = 'no-base' | 'create' | 'deliver';

export interface ResourcePayHandle {
  resource: MolioResource | null;
  phase: PayPhase;
  qrDataUrl: string;
  downloadUrl: string;
  outTradeNo: string;
  errorKind: PayErrorKind | null;
  /** 打开支付弹窗并下单；免费资源 / payUrl 资源不应走这里 */
  open: (r: MolioResource) => void;
  /** 关闭弹窗：清轮询、回 idle */
  close: () => void;
}

const POLL_INTERVAL_MS = 3000;

export function useResourcePay(): ResourcePayHandle {
  const [resource, setResource] = useState<MolioResource | null>(null);
  const [phase, setPhase] = useState<PayPhase>('idle');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [downloadUrl, setDownloadUrl] = useState('');
  const [outTradeNo, setOutTradeNo] = useState('');
  const [errorKind, setErrorKind] = useState<PayErrorKind | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 会话令牌：每次 open/close 递增，异步回调回来时比对，避免关窗后 setState
  const sessionRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const close = useCallback(() => {
    sessionRef.current += 1;
    stopPolling();
    setPhase('idle');
    setResource(null);
    setQrDataUrl('');
    setDownloadUrl('');
    setOutTradeNo('');
    setErrorKind(null);
  }, [stopPolling]);

  const open = useCallback(
    (r: MolioResource) => {
      sessionRef.current += 1;
      const session = sessionRef.current;
      const alive = () => sessionRef.current === session;

      stopPolling();
      setResource(r);
      setPhase('creating');
      setQrDataUrl('');
      setDownloadUrl('');
      setOutTradeNo('');
      setErrorKind(null);

      if (!PAY_BASE) {
        setPhase('error');
        setErrorKind('no-base');
        return;
      }

      fetch(`${PAY_BASE}/pay?id=${encodeURIComponent(r.id)}`)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json() as Promise<{ code_url: string; out_trade_no: string }>;
        })
        .then((data) => {
          if (!alive()) return;
          setOutTradeNo(data.out_trade_no);
          return QRCode.toDataURL(data.code_url, {
            width: 200,
            margin: 1,
            errorCorrectionLevel: 'M',
          }).then((url) => {
            if (!alive()) return;
            setQrDataUrl(url);
            setPhase('waiting');

            pollRef.current = setInterval(() => {
              fetch(`${PAY_BASE}/order?out_trade_no=${encodeURIComponent(data.out_trade_no)}`)
                .then((res) => res.json() as Promise<{ status: string }>)
                .then((st) => {
                  if (!alive()) return;
                  if (st.status !== 'SUCCESS') return;
                  stopPolling();
                  setPhase('delivering');
                  fetch(
                    `${PAY_BASE}/deliver?id=${encodeURIComponent(r.id)}&out_trade_no=${encodeURIComponent(data.out_trade_no)}`,
                  )
                    .then((res) => {
                      if (!res.ok) throw new Error(`HTTP ${res.status}`);
                      return res.json() as Promise<{ url: string }>;
                    })
                    .then((d) => {
                      if (!alive()) return;
                      setDownloadUrl(d.url);
                      setPhase('success');
                    })
                    .catch(() => {
                      if (!alive()) return;
                      setPhase('error');
                      setErrorKind('deliver');
                    });
                })
                .catch(() => {
                  /* 单次轮询失败忽略，继续 */
                });
            }, POLL_INTERVAL_MS);
          });
        })
        .catch((e) => {
          console.error('[resources] create pay order failed:', e);
          if (!alive()) return;
          stopPolling();
          setPhase('error');
          setErrorKind('create');
        });
    },
    [stopPolling],
  );

  // 卸载兜底：组件销毁时清理轮询
  useEffect(() => stopPolling, [stopPolling]);

  return { resource, phase, qrDataUrl, downloadUrl, outTradeNo, errorKind, open, close };
}
