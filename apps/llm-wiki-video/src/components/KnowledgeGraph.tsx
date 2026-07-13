import {interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {EASE_OUT, PALETTE} from '../theme';

export type GraphNode = {
  id: string;
  label: string;
  x: number;
  y: number;
  size?: number;
  accent?: boolean;
};

export type GraphEdge = {from: string; to: string};

type KnowledgeGraphProps = {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  delay?: number;
  activeId?: string;
};

export const KnowledgeGraph = ({nodes, edges, delay = 0, activeId}: KnowledgeGraphProps) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  return (
    <svg width="100%" height="100%" viewBox="0 0 1000 560" role="img" aria-label="知识图谱">
      {edges.map((edge, index) => {
        const from = nodeById.get(edge.from);
        const to = nodeById.get(edge.to);
        if (!from || !to) return null;
        const progress = interpolate(
          frame,
          [delay + (index * fps) / 7, delay + (index * fps) / 7 + 0.7 * fps],
          [0, 1],
          {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: EASE_OUT},
        );
        const length = Math.hypot(to.x - from.x, to.y - from.y);
        return (
          <line
            key={`${edge.from}-${edge.to}`}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke={PALETTE.edgeStrong}
            strokeWidth={2.4}
            strokeDasharray={length}
            strokeDashoffset={length * (1 - progress)}
          />
        );
      })}
      {nodes.map((node, index) => {
        const enter = interpolate(
          frame,
          [delay + index * 4, delay + index * 4 + 0.55 * fps],
          [0, 1],
          {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: EASE_OUT},
        );
        const size = node.size ?? 58;
        const active = node.id === activeId || node.accent;
        return (
          <g
            key={node.id}
            transform={`translate(${node.x} ${node.y}) scale(${0.65 + enter * 0.35})`}
            opacity={enter}
          >
            <circle
              r={size}
              fill={active ? 'rgba(139,92,246,0.23)' : PALETTE.surface}
              stroke={active ? PALETTE.accent : PALETTE.edgeStrong}
              strokeWidth={active ? 4 : 2}
            />
            <text
              textAnchor="middle"
              dominantBaseline="middle"
              fill={PALETTE.text}
              fontSize={active ? 25 : 22}
              fontWeight={700}
            >
              {node.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
};
