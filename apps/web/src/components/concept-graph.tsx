'use client';

import { useQuery } from '@tanstack/react-query';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/primitives';
import { api } from '@/lib/api';

interface GraphResponse {
  version: number;
  truncated: boolean;
  nodes: { id: string; title: string; type: string; trustTier: string; isStale: boolean }[];
  edges: { source: string; target: string }[];
}
type Node = SimulationNodeDatum & GraphResponse['nodes'][number];

const PALETTE = ['#4f6bed', '#16a34a', '#d97706', '#db2777', '#0891b2', '#7c3aed', '#65a30d', '#dc2626', '#0d9488', '#9333ea'];
const MAX_RENDERED = 600;
const W = 900;
const H = 520;

/** Force-directed view of concept-to-concept links (like Google's OKF viz, server-backed). */
export function ConceptGraph({ datasetId, version, versionQs }: { datasetId: string; version?: number; versionQs: string }) {
  const router = useRouter();
  const q = useQuery({ queryKey: ['graph', datasetId, version], queryFn: () => api<GraphResponse>(`/datasets/${datasetId}/graph`, { query: { version } }) });
  const [hover, setHover] = React.useState<string | null>(null);

  const layout = React.useMemo(() => {
    if (!q.data || q.data.nodes.length === 0 || q.data.nodes.length > MAX_RENDERED) return null;
    const nodes: Node[] = q.data.nodes.map((n) => ({ ...n }));
    const links: SimulationLinkDatum<Node>[] = q.data.edges.map((e) => ({ source: e.source, target: e.target }));
    const sim = forceSimulation(nodes)
      .force('link', forceLink<Node, SimulationLinkDatum<Node>>(links).id((n) => n.id).distance(60))
      .force('charge', forceManyBody().strength(-120))
      .force('center', forceCenter(W / 2, H / 2))
      .force('collide', forceCollide(12))
      .stop();
    for (let i = 0; i < 300; i++) sim.tick();
    const types = [...new Set(nodes.map((n) => n.type))];
    return { nodes, links: links as { source: Node; target: Node }[], color: (t: string) => PALETTE[types.indexOf(t) % PALETTE.length]!, types };
  }, [q.data]);

  if (q.isLoading || !q.data) return null;
  if (q.data.nodes.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Concept graph</CardTitle>
        <CardDescription>Nodes are concepts; edges are resolved markdown links (OKF §6). Click a node to open it.</CardDescription>
      </CardHeader>
      <CardContent>
        {!layout ? (
          <p className="text-sm text-muted-foreground">This bundle has {q.data.nodes.length} concepts — too many to draw legibly. Use the Query tab to explore the links table.</p>
        ) : (
          <>
            <div className="mb-2 flex flex-wrap gap-3 text-xs">
              {layout.types.map((t) => (
                <span key={t} className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full" style={{ background: layout.color(t) }} />
                  {t}
                </span>
              ))}
            </div>
            <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full rounded-md border bg-muted/30" role="img" aria-label={`Graph of ${layout.nodes.length} concepts and ${layout.links.length} links`}>
              <g stroke="currentColor" className="text-border">
                {layout.links.map((l, i) => (
                  <line key={i} x1={l.source.x} y1={l.source.y} x2={l.target.x} y2={l.target.y} strokeWidth={hover && (l.source.id === hover || l.target.id === hover) ? 2 : 1} className={hover && (l.source.id === hover || l.target.id === hover) ? 'text-primary' : undefined} />
                ))}
              </g>
              {layout.nodes.map((n) => (
                <g
                  key={n.id}
                  transform={`translate(${n.x},${n.y})`}
                  className="cursor-pointer"
                  tabIndex={0}
                  role="link"
                  aria-label={n.title}
                  onMouseEnter={() => setHover(n.id)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => router.push(`/datasets/${datasetId}/concepts/${n.id.split('/').map(encodeURIComponent).join('/')}${versionQs}`)}
                  onKeyDown={(e) => e.key === 'Enter' && router.push(`/datasets/${datasetId}/concepts/${n.id.split('/').map(encodeURIComponent).join('/')}${versionQs}`)}
                >
                  <circle r={hover === n.id ? 8 : 6} fill={layout.color(n.type)} stroke={n.isStale ? '#d97706' : 'white'} strokeWidth={1.5} />
                  {hover === n.id || layout.nodes.length <= 40 ? (
                    <text x={10} y={4} fontSize={11} className="fill-current">
                      {n.title}
                    </text>
                  ) : null}
                </g>
              ))}
            </svg>
          </>
        )}
      </CardContent>
    </Card>
  );
}
