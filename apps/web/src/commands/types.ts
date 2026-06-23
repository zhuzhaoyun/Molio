/** A slash command available in the ChatComposer command palette. */
export interface Command {
  /** Unique command id, e.g. "new-doc", "browse-kb" */
  id: string;
  /** Unicode icon displayed in the palette */
  icon: string;
  /** Short label shown in the list */
  label: string;
  /** One-line description of what the command does */
  description: string;
  /**
   * The action to execute. Return value semantics:
   * - `{ type: 'navigate', route: string }` → navigate to route
   * - `{ type: 'insert', text: string }` → insert text into composer
   * - `{ type: 'callback', key: string }` → invoke a named callback registered by the host
   * - `{ type: 'none' }` → no-op (palette closes, nothing happens)
   */
  action: CommandAction;
}

export type CommandAction =
  | { type: 'navigate'; route: string }
  | { type: 'insert'; text: string }
  | { type: 'callback'; key: string }
  | { type: 'none' };
