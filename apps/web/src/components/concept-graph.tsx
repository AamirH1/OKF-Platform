'use client';

import { useQuery } from '@tanstack/react-query';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import { Maximize2, Minus, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/primitives';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

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
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Interactive force-directed view of concept-to-concept links: scroll or buttons to zoom,
 * drag the background to pan, drag nodes to rearrange, click a type to filter, click a node to open it.
 */
export function ConceptGraph({ datasetId, version, versionQs }: { datasetId: string; version?: number; versionQs: string }) {
  const router = useRouter();
  const q = useQuery({ queryKey: ['graph', datasetId, version], queryFn: () => api<GraphResponse>(`/datasets/${datasetId}/graph`, { query: { version } }) });
  const [hover, setHover] = React.useState<string | null>(null);
  const [hidden, setHidden] = React.useState<Set<string>>(new Set());
  const [view, setView] = React.useState({ x: 0, y: 0, k: 1 });
  const [pos, setPos] = React.useState<Map<string, { x: number; y: number }>>(new Map());
  const svg = React.useRef<SVGSVGElement>(null);
  const drag = React.useRef<{ kind: 'pan' | 'node'; id?: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);

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
    const neighbors = new Map<string, Set<string>>();
    for (const e of q.data.edges) {
      neighbors.set(e.source, (neighbors.get(e.source) ?? new Set()).add(e.target));
      neighbors.set(e.target, (neighbors.get(e.target) ?? new Set()).add(e.source));
    }
    return { nodes, edges: q.data.edges, types, neighbors, color: (t: string) => PALETTE[types.indexOf(t) % PALETTE.length]! };
  }, [q.data]);

  React.useEffect(() => {
    if (layout) setPos(new Map(layout.nodes.map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }])));
  }, [layout]);

  // Wheel zoom around the cursor (non-passive listener so the page does not scroll).
  React.useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = ((e.clientX - r.left) / r.width) * W;
      const my = ((e.clientY - r.top) / r.height) * H;
      setView((v) => {
        const k = clamp(v.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.3, 4);
        return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [layout]);

  if (q.isLoading || !q.data || q.data.nodes.length === 0) return null;

  const toSvg = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const onPointerDown = (e: React.PointerEvent, id?: string) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = toSvg(e);
    const origin = id ? pos.get(id)! : { x: view.x, y: view.y };
    drag.current = { kind: id ? 'node' : 'pan', id, sx: p.x, sy: p.y, ox: origin.x, oy: origin.y, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = toSvg(e);
    const dx = p.x - d.sx;
    const dy = p.y - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.kind === 'pan') setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
    else setPos((m) => new Map(m).set(d.id!, { x: d.ox + dx / view.k, y: d.oy + dy / view.k }));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === 'node' && !d.moved && d.id) open(d.id);
  };
  const open = (id: string) => router.push(`/datasets/${datasetId}/concepts/${id.split('/').map(encodeURIComponent).join('/')}${versionQs}`);
  const zoom = (f: number) => setView((v) => {
    const k = clamp(v.k * f, 0.3, 4);
    return { k, x: W / 2 - ((W / 2 - v.x) * k) / v.k, y: H / 2 - ((H / 2 - v.y) * k) / v.k };
  });
  const toggleType = (t: string) => setHidden((h) => {
    const next = new Set(h);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    return next;
  });

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Concept graph</CardTitle>
          <CardDescription>Scroll to zoom, drag to pan or move nodes, click a node to open it. Edges are resolved markdown links (OKF §6).</CardDescription>
        </div>
        {layout ? (
          <div className="flex gap-1">
            <Button variant="outline" size="icon" aria-label="Zoom in" onClick={() => zoom(1.25)}>
              <Plus />
            </Button>
            <Button variant="outline" size="icon" aria-label="Zoom out" onClick={() => zoom(0.8)}>
              <Minus />
            </Button>
            <Button variant="outline" size="icon" aria-label="Reset view" onClick={() => (setView({ x: 0, y: 0, k: 1 }), setHidden(new Set()), setPos(new Map(layout.nodes.map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]))))}>
              <Maximize2 />
            </Button>
          </div>
        ) : null}
      </CardHeader>
      <CardContent>
        {!layout ? (
          <p className="text-sm text-muted-foreground">This bundle has {q.data.nodes.length} concepts — too many to draw legibly. Use the Query tab to explore the links table.</p>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter by type">
              {layout.types.map((t) => {
                const off = hidden.has(t);
                return (
                  <button
                    key={t}
                    onClick={() => toggleType(t)}
                    aria-pressed={!off}
                    className={cn('flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-all hover:border-primary/50', off && 'opacity-40 line-through')}
                  >
                    <span className="size-2.5 rounded-full" style={{ background: layout.color(t) }} />
                    {t}
                  </button>
                );
              })}
            </div>
            <svg
              ref={svg}
              viewBox={`0 0 ${W} ${H}`}
              className="h-auto w-full touch-none select-none rounded-md border bg-muted/30 cursor-grab active:cursor-grabbing"
              role="img"
              aria-label={`Graph of ${layout.nodes.length} concepts and ${layout.edges.length} links`}
              onPointerDown={(e) => onPointerDown(e)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={() => (drag.current = null)}
            >
              <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
                <g stroke="currentColor">
                  {layout.edges.map((e, i) => {
                    const a = pos.get(e.source);
                    const b = pos.get(e.target);
                    const na = layout.nodes.find((n) => n.id === e.source);
                    const nb = layout.nodes.find((n) => n.id === e.target);
                    if (!a || !b || !na || !nb || hidden.has(na.type) || hidden.has(nb.type)) return null;
                    const lit = hover && (e.source === hover || e.target === hover);
                    return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth={(lit ? 2 : 1) / view.k} className={cn('transition-colors', lit ? 'text-primary' : 'text-border')} />;
                  })}
                </g>
                {layout.nodes.map((n) => {
                  const p = pos.get(n.id);
                  if (!p || hidden.has(n.type)) return null;
                  const dim = hover && hover !== n.id && !layout.neighbors.get(hover)?.has(n.id);
                  return (
                    <g
                      key={n.id}
                      transform={`translate(${p.x},${p.y})`}
                      className={cn('cursor-pointer transition-opacity', dim && 'opacity-25')}
                      tabIndex={0}
                      role="link"
                      aria-label={n.title}
                      onPointerDown={(e) => onPointerDown(e, n.id)}
                      onMouseEnter={() => setHover(n.id)}
                      onMouseLeave={() => setHover(null)}
                      onKeyDown={(e) => e.key === 'Enter' && open(n.id)}
                    >
                      <circle r={(hover === n.id ? 9 : 6) / Math.sqrt(view.k)} fill={layout.color(n.type)} stroke={n.isStale ? '#d97706' : 'white'} strokeWidth={1.5 / view.k} className="transition-all" />
                      {hover === n.id || layout.nodes.length <= 40 || view.k > 1.8 ? (
                        <text x={10 / view.k} y={4 / view.k} fontSize={11 / view.k} className="pointer-events-none fill-current">
                          {n.title}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
              </g>
            </svg>
          </>
        )}
      </CardContent>
    </Card>
  );
}
