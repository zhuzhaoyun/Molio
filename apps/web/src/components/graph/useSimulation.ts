/**
 * useSimulation — d3-force physics engine hook for Sigma/Graphology.
 *
 * Unlike typical hooks, this one is init-driven: call .init() inside your
 * useEffect to bind the simulation to a graph+sigma pair.
 * The returned methods (wake, stop, getNode) are stable refs usable anywhere.
 */

import { useRef, useCallback } from 'react';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
  type ForceX,
  type ForceY,
  type ForceManyBody,
  type ForceLink,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import type Graph from 'graphology';
import type Sigma from 'sigma';

export interface D3Node extends SimulationNodeDatum {
  id: string;
  radius: number;
  initX: number;  // Rest position X — node springs back here when released
  initY: number;  // Rest position Y — node springs back here when released
}

export interface D3Link extends SimulationLinkDatum<D3Node> {
  source: string;
  target: string;
}

export interface SimulationAPI {
  /** Bind the simulation to a graphology graph. Positions sync on tick callbacks. Call inside useEffect. */
  init: (graph: Graph, sigma: Sigma, _onTick?: () => void) => void;
  /** Wake up the simulation (call during drag). */
  wake: (alpha?: number) => void;
  /** Stop the simulation. */
  stop: () => void;
  /** Get the d3 node object for a given node ID. Returns undefined if not found. */
  getNode: (id: string) => D3Node | undefined;
  /** Update a single d3-force parameter by name (centerStrength, repelStrength, linkStrength, linkDistance). */
  setForceParam: (name: string, value: number) => void;
}

export function useSimulation(): SimulationAPI {
  const simRef = useRef<ReturnType<typeof forceSimulation<D3Node>> | null>(null);
  const nodesRef = useRef<D3Node[]>([]);

  const stop = useCallback(() => {
    if (simRef.current) {
      simRef.current.stop();
      simRef.current = null;
    }
    nodesRef.current = [];
  }, []);

  const init = useCallback((graph: Graph, sigma: Sigma, _onTick?: () => void) => {
    // Kill previous simulation if any
    if (simRef.current) {
      simRef.current.stop();
    }

    if (graph.order === 0) {
      simRef.current = null;
      nodesRef.current = [];
      return;
    }

    // Build d3 node array from graphology
    const d3Nodes: D3Node[] = [];
    const d3Links: D3Link[] = [];

    graph.forEachNode((key, attrs) => {
      const x = (attrs.x as number) ?? Math.random() * 100;
      const y = (attrs.y as number) ?? Math.random() * 100;
      const node: D3Node = {
        id: key,
        x,
        y,
        initX: x,  // Record initial position as spring rest target
        initY: y,
        radius: Math.max((attrs.size as number) ?? 6, 4),
      };
      d3Nodes.push(node);
    });

    graph.forEachEdge((_key, _attrs, source, target) => {
      d3Links.push({ source: source as string, target: target as string });
    });

    nodesRef.current = d3Nodes;

    // Create d3-force simulation with 4 forces
    const simulation = forceSimulation<D3Node>(d3Nodes)
      .force(
        'link',
        forceLink<D3Node, D3Link>(d3Links)
          .id((d) => d.id)
          .distance(100)
          .strength(0.15),
      )
      .force('charge', forceManyBody<D3Node>().strength(-60).distanceMax(250))
      .force('collide', forceCollide<D3Node>().radius((d) => d.radius + 6))
      // Individual spring forces — each node has its own rest position (initX/initY).
      // Drag stretches the spring, release snaps back with damping → "rubber band" feel.
      .force('x', forceX<D3Node>((d) => (d.fx != null ? d.fx : d.initX)).strength(0.004))
      .force('y', forceY<D3Node>((d) => (d.fy != null ? d.fy : d.initY)).strength(0.004))
      .alphaDecay(0.03)
      .velocityDecay(0.35)
      .on('tick', () => {
        // Write d3 coordinates back to graphology (no renderer.refresh here!)
        // Rendering is driven by the interaction handler's explicit refresh,
        // or by a RAF loop. Decoupling physics ticks from rendering prevents
        // flicker caused by two sources calling refresh() at conflicting rates.
        for (const d of d3Nodes) {
          if (graph.hasNode(d.id)) {
            graph.setNodeAttribute(d.id, 'x', d.x);
            graph.setNodeAttribute(d.id, 'y', d.y);
          }
        }
      });

    simRef.current = simulation;
  }, []);

  const wake = useCallback((alpha = 0.15) => {
    if (simRef.current) {
      simRef.current.alpha(alpha).restart();
    }
  }, []);

  const getNode = useCallback((id: string): D3Node | undefined => {
    return nodesRef.current.find((n) => n.id === id);
  }, []);

  const setForceParam = useCallback((name: string, value: number) => {
    const sim = simRef.current;
    if (!sim) return;

    switch (name) {
      case 'centerStrength':
        sim.force<ForceX<D3Node>>('x')?.strength(value);
        sim.force<ForceY<D3Node>>('y')?.strength(value);
        break;
      case 'repelStrength':
        sim.force<ForceManyBody<D3Node>>('charge')?.strength(value);
        break;
      case 'linkStrength':
        sim.force<ForceLink<D3Node, D3Link>>('link')?.strength(value);
        break;
      case 'linkDistance':
        sim.force<ForceLink<D3Node, D3Link>>('link')?.distance(value);
        break;
    }
    sim.alpha(0.3).restart();
  }, []);

  return { init, wake, stop, getNode, setForceParam };
}
