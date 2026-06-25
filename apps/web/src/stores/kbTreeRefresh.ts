/**
 * Tree-refresh bridge — lets App-level wikiChat.onComplete trigger
 * KnowledgeBasePage's kb.refreshTree() without holding a direct reference.
 *
 * KnowledgeBasePage registers its refreshTree on mount, clears on unmount.
 * The App-level wikiChat hook (which lives across route switches) calls
 * refresh() when a run completes. If the KB page is unmounted at that
 * moment, the call is a no-op — the page will fetch a fresh tree on remount.
 */

type Refresher = () => void;

let currentRefresher: Refresher | null = null;

export const kbTreeRefreshStore = {
  setRefresher(fn: Refresher | null) {
    currentRefresher = fn;
  },
  refresh() {
    currentRefresher?.();
  },
};
