import { api } from '../api/client';
import { vaultStore } from '../stores/vaultStore';

interface Props {
  content: string;
  timestamp: number;
}

// Split content by markdown image syntax ![image](path) and render actual images
function renderContent(content: string): React.ReactNode {
  const vaultId = vaultStore.getActiveVaultId();
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
    const imgUrl = vaultId ? api.rawFileUrl(vaultId, filePath) : filePath;

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
        <span className="user-image-view">查看原图 ↗</span>
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
  const rendered = renderContent(content);

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
