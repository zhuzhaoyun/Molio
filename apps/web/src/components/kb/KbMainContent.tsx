/**
 * Main content area — tabs (Preview / Raw / History) with panels.
 */

import { useMemo } from 'react';
import type { FileContent, KbHistoryEntry } from '@kge/contracts';
import type { KbTab } from '../../hooks/useKnowledge';
import { renderKnowledgeMarkdown } from '../../utils/markdown';

interface KbMainContentProps {
  fileContent: FileContent | null;
  history: KbHistoryEntry[];
  activeTab: KbTab;
  selectedFile: string | null;
  onTabChange: (tab: KbTab) => void;
}

export function KbMainContent({
  fileContent,
  history,
  activeTab,
  selectedFile,
  onTabChange,
}: KbMainContentProps) {
  // Render markdown preview
  const previewHtml = useMemo(() => {
    if (!fileContent?.content) return '';
    return renderKnowledgeMarkdown(fileContent.content);
  }, [fileContent?.content]);

  // No file selected — show empty state
  if (!selectedFile) {
    return (
      <main className="kb-main">
        <div className="kb-empty-state">
          <div className="kb-empty-icon">📚</div>
          <h3>No file selected</h3>
          <p>Select a file from the tree to view its content.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="kb-main">
      {/* Content tabs */}
      <div className="kb-content-tabs">
        <TabButton label="Preview" tab="preview" active={activeTab} onChange={onTabChange} />
        <TabButton label="Raw" tab="raw" active={activeTab} onChange={onTabChange} />
        <TabButton label="History" tab="history" active={activeTab} onChange={onTabChange} />
      </div>

      {/* Tab panels */}
      <div className="kb-tab-content">
        {/* Preview panel */}
        <div className={`kb-tab-panel ${activeTab === 'preview' ? 'is-active' : ''}`}>
          {fileContent ? (
            <div
              className="kb-md-preview"
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          ) : (
            <div className="kb-empty-state">
              <p>Loading...</p>
            </div>
          )}
        </div>

        {/* Raw panel */}
        <div className={`kb-tab-panel ${activeTab === 'raw' ? 'is-active' : ''}`}>
          {fileContent ? (
            <div className="kb-raw-content">
              <pre>{fileContent.content}</pre>
            </div>
          ) : (
            <div className="kb-empty-state">
              <p>Loading...</p>
            </div>
          )}
        </div>

        {/* History panel */}
        <div className={`kb-tab-panel ${activeTab === 'history' ? 'is-active' : ''}`}>
          <div className="kb-history-content">
            {history.length > 0 ? (
              history.map((entry) => (
                <div key={entry.id} className="kb-history-item">
                  <div className="kb-history-meta">
                    {formatDate(entry.createdAt)}
                    <br />
                    {formatTime(entry.createdAt)}
                  </div>
                  <div className="kb-history-body">
                    <div className="kb-h-title">{actionLabel(entry.action)}</div>
                    <div className="kb-h-detail">{entry.detail}</div>
                  </div>
                </div>
              ))
            ) : (
              <div className="kb-empty-state">
                <p>No history yet.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

// ─── Helpers ───

function TabButton({
  label,
  tab,
  active,
  onChange,
}: {
  label: string;
  tab: KbTab;
  active: KbTab;
  onChange: (tab: KbTab) => void;
}) {
  return (
    <button
      type="button"
      className={`kb-tab ${active === tab ? 'is-active' : ''}`}
      onClick={() => onChange(tab)}
    >
      {label}
    </button>
  );
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString([], { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    ingest: 'Ingest',
    lint: 'Lint',
    edit: 'Edit',
    import: 'Import',
  };
  return labels[action] ?? action;
}
