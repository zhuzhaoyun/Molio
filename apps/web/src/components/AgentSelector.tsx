import type { AgentInfo } from '@kge/contracts';

interface Props {
  agents: AgentInfo[];
  selected: string | null;
  onSelect: (id: string) => void;
}

export function AgentSelector({ agents, selected, onSelect }: Props) {
  return (
    <select
      value={selected ?? ''}
      onChange={(e) => onSelect(e.target.value)}
      className="agent-selector"
    >
      <option value="" disabled>Select agent...</option>
      {agents.map((agent) => (
        <option key={agent.id} value={agent.id} disabled={!agent.available}>
          {agent.name} {agent.available
            ? `(v${agent.version?.split(' ')[0] ?? '?'})`
            : '(not installed)'}
        </option>
      ))}
    </select>
  );
}
