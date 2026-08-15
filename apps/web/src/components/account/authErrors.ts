/**
 * Maps daemon /api/auth error codes to i18n message keys.
 * daemon 回 `{error: code}`（云端 4xx 透传 + 502/503 自造），UI 按 code 映射文案。
 */

import { AuthApiError } from '../../api/client';

export interface AuthErrorRef {
  key: string;
  params?: Record<string, string | number>;
}

export function authErrorRef(err: unknown): AuthErrorRef {
  if (!(err instanceof AuthApiError)) {
    return { key: 'login.errGeneric', params: { code: 'network' } };
  }
  switch (err.code) {
    case 'invalid_email':
      return { key: 'login.errInvalidEmail' };
    case 'rate_limited':
      return { key: 'login.errRateLimited', params: { sec: err.resendAfterSec ?? 60 } };
    case 'mail_failed':
      return { key: 'login.errMailFailed' };
    case 'invalid_code':
      return { key: 'login.errInvalidCode' };
    case 'locked':
      return { key: 'login.errLocked' };
    case 'cloud_unreachable':
      return { key: 'login.errUnreachable' };
    case 'auth_not_configured':
      return { key: 'login.errNotConfigured' };
    case 'invalid_token':
    case 'no_session':
      return { key: 'login.errExpired' };
    default:
      return { key: 'login.errGeneric', params: { code: err.code } };
  }
}
