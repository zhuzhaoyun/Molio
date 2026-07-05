/**
 * Type declarations for turndown-plugin-gfm (no bundled types).
 * The plugin registers GFM rules (tables, strikethrough, task lists, etc.)
 * on a TurndownService instance.
 */
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  export function gfm(turndownService: TurndownService): void;
  export function tables(turndownService: TurndownService): void;
  export function strikethrough(turndownService: TurndownService): void;
  export function taskListItems(turndownService: TurndownService): void;
  export function highlightedCodeBlock(turndownService: TurndownService): void;
}
