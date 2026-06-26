import { api } from '../api/client';
import { useActiveVaultId } from '../stores/vaultStore';
import { useI18n } from '../i18n';

interface Props {
  content: string;
  timestamp: number;
}

/**
 * A path is safe to turn into a vault raw-file URL only when it is a plain
 * relative path. Reject anything that looks like a URL scheme (javascript:,
 * data:, etc.) — when vaultId is absent we would otherwise feed the raw value
 * straight into href/src, enabling script execution from stored/restored
 * message content.
 */
function isSafeImagePath(filePath: string): boolean {
  // Disallow an explicit scheme (contains a colon before any slash).
  return !/(^[a-z][a-z0-9+.-]*:)/i.test(filePath);
}

// Split content by markdown image syntax ![image](path) and render actual images.
// vaultId is passed in (from a reactive hook in the component) so the message
// re-renders when the active vault changes — reading the store imperatively
// during render yields stale URLs.
function renderContent(content: string, vaultId: string | null, t: (key: string) => string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  const regex = /!\[image\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = regex.exec(content)) !== null) {
    // Text before the image
    if (match.index > lastIndex) {
      const text = content.slice(lastIndex, match.index).trim();
      if (text) {
        parts.push(<span key={key++}>{text}</span>);
      }
    }

    const filePath = match[1];

    // Only render an image when we can resolve it to a safe vault URL. If
    // there is no active vault or the path looks like a URL scheme, render the
    // raw markdown as plain text instead of risking javascript:/data: URLs.
    if (!vaultId || !isSafeImagePath(filePath)) {
      parts.push(<span key={key++}>{match[0]}</span>);
      lastIndex = match.index + match[0].length;
      continue;
    }

    const imgUrl = api.rawFileUrl(vaultId, filePath);
    parts.push(
      <a
        key={key++}
        href={imgUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="user-image-link"
        data-testid="user-image"
      >
        <img src={imgUrl} alt={filePath} className="user-image" />
        <span className="user-image-view">{t('userMessage.viewOriginal')} ↗</span>
      </a>,
    );

    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last image
  if (lastIndex < content.length) {
    const text = content.slice(lastIndex).trim();
    if (text) {
      parts.push(<span key={key++}>{text}</span>);
    }
  }

  // If no images found, return plain text
  if (parts.length === 0) return content;

  return parts;
}

export function UserMessage({ content, timestamp }: Props) {
  const vaultId = useActiveVaultId();
  const { t } = useI18n();
  const rendered = renderContent(content, vaultId, t);

  return (
    <div className="msg user" data-testid="user-message">
      <div className="role">
        <span className="msg-time">{formatTime(timestamp)}</span>
      </div>
      <div className="user-text">{rendered}</div>
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
