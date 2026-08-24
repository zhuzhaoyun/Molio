/**
 * 验证码登录表单（两步：邮箱 → 验证码）。注册 = 登录（云端隐式建号）。
 * 只跟 daemon 本地镜像端点说话（设计 §五）；devCode 仅 daily/local 云端返回，
 * UI 不展示（E2E 直接从 /api/auth/start 响应取）。
 */

import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { api } from '../../api/client';
import { authErrorRef } from './authErrors';

interface LoginFormProps {
  /** 登录成功后回调（父组件刷新 authStore）。 */
  onSuccess: () => void;
}

type Step = 'email' | 'code';

/** 基础邮箱格式（与云端 AuthService.EMAIL_RE 同规则）：客户端先行拦截，
    非法输入不发起发码请求（云端 400 invalid_email 仍是兜底） */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginForm({ onSuccess }: LoginFormProps) {
  const { t } = useI18n();
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  // 用户协议/隐私政策勾选（个保法上线前置，设计 §十二）。未勾选禁止发送验证码。
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [resendSec, setResendSec] = useState(0);
  const timerRef = useRef<number | null>(null);
  /**
   * 邮箱在发送验证码时快照。验证必须用「发出验证码的那个邮箱」，而不是提交时
   * 输入框的实时值——用户返回上一步改了邮箱再点验证，会把旧验证码对新邮箱
   * 提交（云端必然失败，且错误提示令人困惑）。
   */
  const sentEmailRef = useRef('');
  /** 组件卸载后（关闭弹窗/切视图）异步续体不得再 setState。 */
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, []);

  function startCountdown(sec: number) {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    let remaining = sec > 0 ? sec : 60;
    setResendSec(remaining);
    // 倒计时状态在 interval 回调里用局部变量维护——setState updater 必须保持
    // 纯函数（StrictMode 会双调用 updater，副作用放里面会把 clearInterval
    // 执行两次/提前清零）。
    timerRef.current = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        if (timerRef.current !== null) window.clearInterval(timerRef.current);
        timerRef.current = null;
        setResendSec(0);
      } else {
        setResendSec(remaining);
      }
    }, 1000);
  }

  async function sendCode(fromStep: Step) {
    const trimmed = email.trim();
    if (!trimmed || busy || !agreed || !EMAIL_RE.test(trimmed)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.authSendCode(trimmed);
      if (!aliveRef.current) return;
      sentEmailRef.current = trimmed;
      if (fromStep === 'email') setStep('code');
      setNotice(t('login.codeSent'));
      startCountdown(res.resendAfterSec ?? 60);
    } catch (e) {
      if (!aliveRef.current) return;
      const ref = authErrorRef(e);
      setError(t(ref.key, ref.params));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  async function handleVerify() {
    const trimmedCode = code.trim();
    if (!trimmedCode || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.authVerify(sentEmailRef.current, trimmedCode);
      if (!aliveRef.current) return;
      onSuccess();
    } catch (e) {
      if (!aliveRef.current) return;
      const ref = authErrorRef(e);
      setError(t(ref.key, ref.params));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  // 布局对齐官网登录弹窗（landing-page auth.js）：标题 + 价值副标题 +
  // 纵向表单 + 全宽主按钮 + 链接式次要操作
  return (
    <div className="account-login-form">
      <h3 className="account-login-title">{t('login.title')}</h3>
      <p className="account-login-sub">{t('login.subtitle')}</p>
      {step === 'email' ? (
        <>
          <div className="account-field">
            <label htmlFor="account-email">{t('login.emailLabel')}</label>
            <input
              id="account-email"
              data-testid="account-email-input"
              type="email"
              value={email}
              placeholder={t('login.emailPlaceholder')}
              autoComplete="email"
              disabled={busy}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void sendCode('email');
              }}
            />
          </div>
          <div className="account-agree-row">
            <label className="account-agree-label">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                data-testid="account-agree-checkbox"
              />
              <span>
                {t('login.agreePrefix')}{' '}
                <a
                  href="https://molio.cn/terms.html"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('login.agreeTerms')}
                </a>{' '}
                {t('login.agreeAnd')}{' '}
                <a
                  href="https://molio.cn/privacy.html"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('login.agreePrivacy')}
                </a>
              </span>
            </label>
          </div>
          <button
            type="button"
            className="kb-btn kb-btn-primary account-login-cta"
            data-testid="account-send-code-btn"
            disabled={busy || !EMAIL_RE.test(email.trim()) || !agreed}
            onClick={() => void sendCode('email')}
          >
            {busy ? t('account.busy') : t('login.sendCode')}
          </button>
        </>
      ) : (
        <>
          {notice && (
            <p className="account-login-note" data-testid="account-notice">
              {notice}
            </p>
          )}
          <div className="account-field">
            <label htmlFor="account-code">{t('login.codeLabel')}</label>
            <input
              id="account-code"
              data-testid="account-code-input"
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={code}
              placeholder={t('login.codePlaceholder')}
              autoComplete="one-time-code"
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleVerify();
              }}
            />
          </div>
          <button
            type="button"
            className="kb-btn kb-btn-primary account-login-cta"
            data-testid="account-verify-btn"
            disabled={busy || code.trim() === ''}
            onClick={() => void handleVerify()}
          >
            {busy ? t('account.busy') : t('login.verify')}
          </button>
          <div className="account-login-links">
            <button
              type="button"
              className="account-link-btn"
              data-testid="account-resend-btn"
              disabled={busy || resendSec > 0}
              onClick={() => void sendCode('code')}
            >
              {resendSec > 0 ? t('login.resendIn', { sec: resendSec }) : t('login.resend')}
            </button>
            <button
              type="button"
              className="account-link-btn"
              data-testid="account-change-email-btn"
              disabled={busy}
              onClick={() => {
                setStep('email');
                setCode('');
                setError(null);
              }}
            >
              {t('login.back')}
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="account-error" data-testid="account-error">
          {error}
        </p>
      )}
    </div>
  );
}
