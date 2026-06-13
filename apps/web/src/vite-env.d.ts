/// <reference types="vite/client" />

// Optional vendor modules (not installed, stubs for typecheck)
declare module 'mermaid' {
  function render(id: string, text: string): Promise<{ svg: string; bindFunctions?: (element: Element) => void }>
  function initialize(config: Record<string, unknown>): void
  export default { render, initialize }
}

declare module '@antv/infographic' {
  export class Infographic {
    constructor(options: any)
    on(event: string, callback: (...args: any[]) => void): void
    render(code: string): void
  }
  export function setDefaultFont(font: string): void
  export function setFontExtendFactor(factor: number): void
  export function exportToSVG(node: any, options?: any): Promise<any>
}
