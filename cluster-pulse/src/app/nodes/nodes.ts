import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ClusterPulseService } from '../core/cluster-pulse.service';
import { NodeSample } from '../core/models';

interface NodeRow {
  node: string;
  state: string;
  coresUsed: number | null;
  coresTotal: number | null;
  ramUsedGb: number;
  ramTotalGb: number;
  gpusAlloc: number | null;
  gpusTotal: number | null;
  load1: number | null;
  cpuPct: number | null;
  uptime: string;
}

/**
 * Nodes screen. Two sources, deliberately kept distinct:
 *  - allocation (cores/RAM/GPUs reserved) comes from PBS via the collector
 *  - live usage (load, real CPU %, RAM in use) comes from the sampler on the node
 * A node with no sampler data still appears from PBS, marked as such.
 */
@Component({
  selector: 'app-nodes',
  imports: [],
  templateUrl: './nodes.html',
  styleUrl: './nodes.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Nodes {
  private readonly feed = inject(ClusterPulseService);

  readonly snapshot = this.feed.snapshot;
  readonly connected = this.feed.connected;

  readonly rows = computed<NodeRow[]>(() => {
    const snap = this.snapshot();
    if (!snap) return [];

    const pbs = new Map<string, any>();
    for (const item of (snap.pbs_nodes as any[]) ?? []) {
      if (item?.node) pbs.set(item.node, item);
    }

    const names = new Set<string>([...pbs.keys()]);
    for (const sample of snap.nodes ?? []) if (sample?.node) names.add(sample.node);

    return [...names].sort().map((name) => {
      const sample: NodeSample | undefined =
        (snap.nodes ?? []).find((n) => n?.node === name) ?? undefined;
      const pbsNode = pbs.get(name);
      return {
        node: name,
        state: sample ? 'live' : pbsNode ? 'pbs only' : 'unknown',
        coresUsed: pbsNode?.assigned?.ncpus ?? null,
        coresTotal: pbsNode?.available?.ncpus ?? sample?.cpu?.logical ?? null,
        ramUsedGb: this.feed.gbFromKb(sample?.mem?.used_kb ?? pbsNode?.assigned?.mem_kb),
        ramTotalGb: this.feed.gbFromKb(sample?.mem?.total_kb ?? pbsNode?.available?.mem_kb),
        gpusAlloc: pbsNode?.assigned?.ngpus ?? null,
        gpusTotal: pbsNode?.available?.ngpus ?? sample?.gpus?.length ?? null,
        load1: sample?.loadavg?.[0] ?? null,
        cpuPct: sample?.cpu?.used_pct ?? null,
        uptime: this.uptime(sample?.uptime_s ?? null),
      };
    });
  });

  loadRatio(row: NodeRow): number {
    if (!row.coresTotal || row.load1 == null) return 0;
    return row.load1 / row.coresTotal;
  }

  loadColour(row: NodeRow): string {
    const ratio = this.loadRatio(row);
    if (ratio < 0.7) return 'var(--green)';
    if (ratio <= 1) return 'var(--amber)';
    return 'var(--red)';
  }

  pct(used: number | null, total: number | null): number {
    if (!total || used == null) return 0;
    return Math.min(100, Math.round((used / total) * 1000) / 10);
  }

  private uptime(seconds: number | null): string {
    if (!seconds) return '—';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
  }
}
