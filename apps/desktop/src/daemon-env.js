/** A packaged desktop daemon is local to this desktop, regardless of shell configuration. */
export function desktopDaemonEnvironment(inherited) {
  return { ...inherited, MOLIO_ACCESS_MODE: 'local', MOLIO_HOST: '127.0.0.1' };
}
