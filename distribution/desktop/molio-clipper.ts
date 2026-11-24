/** A clip may arrive before the daemon binds or before Electron is ready on macOS. */
export function clipperRoute(input: string): string | undefined {
  if (/^molio:\/\/launch\/?$/.test(input)) return '/'
  const match = /^molio:\/\/open\/(?:vault\/([^/]+)\/)?file\/(.+)$/.exec(input)
  if (!match) return undefined
  try {
    const query = new URLSearchParams()
    if (match[1]) query.set('vault', decodeURIComponent(match[1]))
    const path = decodeURIComponent(match[2]!)
    if (!path || /^[\\/]|^[a-z]:/i.test(path) || path.split(/[\\/]/).includes('..')) return undefined
    query.set('file', path)
    return '/knowledge?' + query.toString()
  } catch {
    return undefined
  }
}
