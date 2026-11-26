import { isValidPasswordHash } from './password.js';

export type AccessConfig =
  | { mode: 'local'; host: string }
  | { mode: 'server'; host: string; publicOrigin: string; username: string; passwordHash: string };

export function loadAccessConfig(env: NodeJS.ProcessEnv): AccessConfig {
  const mode = env['MOLIO_ACCESS_MODE'] ?? 'local';
  if (mode !== 'local' && mode !== 'server') throw new Error('Invalid MOLIO_ACCESS_MODE');
  let host = env['MOLIO_HOST']?.trim() || (mode === 'local' ? '127.0.0.1' : '0.0.0.0');
  if (mode === 'local') {
    if (host === 'localhost') host = '127.0.0.1';
    if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
      throw new Error('Local mode requires a loopback listener');
    }
    return { mode, host };
  }
  const username = env['MOLIO_ADMIN_USERNAME']?.trim();
  const passwordHash = env['MOLIO_ADMIN_PASSWORD_HASH']?.trim();
  const rawUrl = env['MOLIO_PUBLIC_URL']?.trim();
  if (!username || !passwordHash || !rawUrl) throw new Error('Server mode requires administrator credentials and MOLIO_PUBLIC_URL');
  if (username.length > 128 || !isValidPasswordHash(passwordHash)) throw new Error('Invalid administrator configuration');
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error('Invalid MOLIO_PUBLIC_URL'); }
  const authority = /^https:\/\/([^/?#]+)\/?$/i.exec(rawUrl)?.[1];
  if (!authority || authority.includes('@') || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('MOLIO_PUBLIC_URL must be an HTTPS origin');
  }
  return { mode, host, publicOrigin: url.origin, username, passwordHash };
}
