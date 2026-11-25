/** Browser-visible administrator session state. No credentials are included. */
export type AccessSession =
  | { mode: 'local'; authenticated: false }
  | { mode: 'server'; authenticated: false }
  | { mode: 'server'; authenticated: true; expiresAt: number; csrfToken: string };

export interface AdminLoginRequest {
  username: string;
  password: string;
}
