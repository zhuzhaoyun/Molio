import { useState } from 'react';

interface Props {
  toolUseId: string;
  toolName: string;
  input: unknown;
  onSubmit: (toolUseId: string, content: string) => void;
}

export function ToolResultInput({ toolUseId, toolName, input, onSubmit }: Props) {
  const [content, setContent] = useState('');

  // Extract question/options from AskUserQuestion input
  const question = extractQuestion(input);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (content.trim()) {
      onSubmit(toolUseId, content.trim());
      setContent('');
    }
  };

  return (
    <div className="tool-result-input">
      <div className="tool-result-question">
        <span className="tool-result-label">{toolName}</span>
        {question && <p>{question}</p>}
      </div>
      <form onSubmit={handleSubmit}>
        <input
          type="text"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Type your answer..."
          autoFocus
        />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}

function extractQuestion(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj['question'] === 'string') return obj['question'] as string;
  if (typeof obj['questions'] === 'object' && Array.isArray(obj['questions'])) {
    const first = obj['questions'][0] as Record<string, unknown> | undefined;
    if (first && typeof first['question'] === 'string') return first['question'] as string;
  }
  return null;
}
