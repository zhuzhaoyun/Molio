import { RobotIcon } from '../icons';

/**
 * Agent 产品标识：各 Agent 官方产品 logo，深浅色分开；未知 Agent 用 RobotIcon 兜底。
 * 注意不把上游厂商 logo 当产品 logo：Codex 用 Codex 应用图标，DSH 用 Harness 专用鲸鱼。
 */
const AGENT_LOGOS: Record<string, string> = {
  claude: 'claude.svg',
  codex: 'codex.png',
  gemini: 'googlegemini.svg',
  qwen: 'qwen.svg',
  dsh: 'dsh.svg',
  hermes: 'hermes.svg',
};

const DARK_LOGOS: Record<string, string> = {
  dsh: 'dsh-dark.svg',
  hermes: 'hermes-dark.svg',
};

export function AgentIcon({ agentId, size = 20 }: { agentId: string; size?: number }) {
  const logo = AGENT_LOGOS[agentId];
  if (!logo) return <RobotIcon size={size} />;
  const dark = DARK_LOGOS[agentId];
  return (
    <>
      <img
        className="agent-icon agent-icon--light"
        src={`${import.meta.env.BASE_URL}images/agents/${logo}`}
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
      />
      {dark && (
        <img
          className="agent-icon agent-icon--dark"
          src={`${import.meta.env.BASE_URL}images/agents/${dark}`}
          width={size}
          height={size}
          alt=""
          aria-hidden="true"
        />
      )}
    </>
  );
}
