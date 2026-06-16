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
  forceCenter,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import type Graph from 'graphology';
import type Sigma from 'sigma';

export interface D3Node extends SimulationNodeDatum {
  id: string;
  radius: number;
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
      const node: D3Node = {
        id: key,
        x: (attrs.x as number) ?? Math.random() * 100,
        y: (attrs.y as number) ?? Math.random() * 100,
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
          .distance(150)
          .strength(0.2),
      )
      .force('charge', forceManyBody<D3Node>().strength(-150).distanceMax(500))
      .force('collide', forceCollide<D3Node>().radius((d) => d.radius + 6))
      .force('center', forceCenter<D3Node>().strength(0.15))
      .alphaDecay(0.02)
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

  return { init, wake, stop, getNode };
}
