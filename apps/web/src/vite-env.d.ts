/// <reference types="vite/client" />

// Vite ?raw import support (also declared in vendor but that file is outside include scope)
declare module '*.css?raw' {
  const content: string
  export default content
}

declare module '*.txt?raw' {
  const content: string
  export default content
}

// Optional vendor modules (not installed, stubs for typecheck)
declare module 'mermaid' {
  export function initialize(config: Record<string, unknown>): void
  export function run(opts?: Record<string, unknown>): Promise<void>
  export function render(id: string, text: string): Promise<{ svg: string; bindFunctions?: (element: Element) => void }>
  export default { initialize, run, render }
}

declare module '@antv/infographic' {
  export function renderInfographic(options: Record<string, unknown>): Promise<string>
  export default { renderInfographic }
}
