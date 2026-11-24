import { Injectable, computed, signal } from '@angular/core';
import {
  Alert,
  ClusterSnapshot,
  HelloMessage,
  Job,
  NodeSample,
  SnapshotMessage,
  UsagePoint,
} from './models';

/**
 * Live cluster feed.
 *
 * The API pushes one message per collector tick (1 Hz). The component layer
 * never polls: it renders what arrives. Two rules from the cluster probe are
 * encoded here so the UI cannot misreport them:
 *
 *  1. node_ts (sampler clock) runs ~11 min behind ingest_ts (mgmt01). Charts and
 *     "updated Xs ago" use ingest_ts only.
 *  2. GPU utilisation is node-wide and includes every user's work — PBS does not
 *     isolate GPUs on this cluster, and there is no job->GPU mapping.
 */
@Injectable({ providedIn: 'root' })
export class ClusterPulseService {
  private readonly httpBase = 'http://localhost:3000';
  private readonly wsUrl = 'ws://localhost:3000/stream';

  private socket: WebSocket | null = null;
  private reconnectDelay = 1000;
  private readonly lastPushAt = signal<number>(0);

  readonly snapshot = signal<ClusterSnapshot | null>(null);
  readonly alerts = signal<Alert[]>([]);
  readonly connected = signal(false);
  readonly jobs = signal<Job[]>([]);
  /** Seconds since the last push; the header shows this so a stale feed is visible. */
  readonly staleness = signal<number>(0);
  /** Rolling chart window: cluster CPU/RAM plus per-node average GPU utilisation. */
  readonly history = signal<UsagePoint[]>([]);
  /** Per-GPU utilisation windows, keyed "gpu01:0" … "gpu02:7" for sparklines. */
  readonly gpuHistory = signal<Record<string, number[]>>({});

  readonly totals = computed(() => this.snapshot()?.totals ?? null);
  readonly queues = computed(() => this.snapshot()?.queues ?? {});

  readonly gpusFree = computed(() => {
    const t = this.totals();
    return t ? t.gpus - t.gpus_alloc : 0;
  });

  readonly jobsRunning = computed(() =>
    Object.values(this.queues()).reduce((n, q) => n + (q.running ?? 0), 0),
  );

  readonly jobsQueued = computed(() =>
    Object.values(this.queues()).reduce((n, q) => n + (q.queued ?? 0), 0),
  );

  /** Actual CPU busy %, averaged across nodes (sampler /proc/stat), not allocation. */
  readonly cpuUsedPct = computed(() => {
    const samples = (this.snapshot()?.nodes ?? [])
      .map((n) => n?.cpu?.used_pct)
      .filter((v): v is number => typeof v === 'number');
    if (!samples.length) return 0;
    return Math.round((samples.reduce((a, b) => a + b, 0) / samples.length) * 10) / 10;
  });

  /** Actual RAM in use across nodes, GB (1 KB = 1/1048576 GB). */
  readonly ramUsedGb = computed(() => {
    const nodes = (this.snapshot()?.nodes ?? []).filter(Boolean);
    const kb = nodes.reduce((sum, n) => sum + (n!.mem?.used_kb ?? 0), 0);
    return Math.round(kb / 1048576);
  });

  /** Total RAM the samplers report across nodes, GB. */
  readonly ramTotalGb = computed(() => {
    const nodes = (this.snapshot()?.nodes ?? []).filter(Boolean);
    const kb = nodes.reduce((sum, n) => sum + (n!.mem?.total_kb ?? 0), 0);
    return Math.round(kb / 1048576);
  });

  /** Average GPU utilisation across every device (node-wide, all users). */
  readonly gpuAvgUtil = computed(() => {
    const utils: number[] = [];
    for (const node of this.snapshot()?.nodes ?? []) {
      for (const gpu of node?.gpus ?? []) {
        if (typeof gpu.util_pct === 'number') utils.push(gpu.util_pct);
      }
    }
    if (!utils.length) return 0;
    return Math.round(utils.reduce((a, b) => a + b, 0) / utils.length);
  });

  readonly cpuPct = computed(() => {
    const t = this.totals();
    return t?.cores ? Math.round((t.cores_alloc / t.cores) * 1000) / 10 : 0;
  });

  readonly ramPct = computed(() => {
    const t = this.totals();
    return t?.mem_kb ? Math.round((t.mem_alloc_kb / t.mem_kb) * 1000) / 10 : 0;
  });

  constructor() {
    this.loadInitial();
    this.loadHistory();
    this.connect();
    // Staleness only moves the header state; it never triggers a fetch.
    if (typeof window !== 'undefined') {
      window.setInterval(() => {
        const last = this.lastPushAt();
        this.staleness.set(last ? Math.round((Date.now() - last) / 1000) : 0);
      }, 1000);
    }
  }

  private async loadInitial(): Promise<void> {
    try {
      const res = await fetch(`${this.httpBase}/api/snapshot`);
      if (!res.ok) return;
      const body = await res.json();
      if (body?.snapshot) this.applySnapshot(body.snapshot);
      if (Array.isArray(body?.nodes)) {
        // The greeting path may carry nodes without a full snapshot.
        const snap = this.snapshot();
        if (!snap) return;
        this.snapshot.set({ ...snap, nodes: body.nodes });
      }
    } catch {
      // API not up yet — the socket retry loop will handle it.
    }
  }

  /** Seed the charts from MySQL so they are not empty on first paint. */
  private async loadHistory(): Promise<void> {
    try {
      const [nodeRes, gpuRes] = await Promise.all([
        fetch(`${this.httpBase}/api/history/nodes?minutes=5`),
        fetch(`${this.httpBase}/api/history/gpus?minutes=5`),
      ]);

      const nodeRows = nodeRes.ok ? ((await nodeRes.json()).rows ?? []) : [];
      const gpuRows = gpuRes.ok ? ((await gpuRes.json()).rows ?? []) : [];

      // Collapse per-node rows into one cluster point per timestamp.
      const byTs = new Map<string, { cpu: number[]; ramUsed: number; ramTotal: number; gpu: Record<string, number> }>();
      for (const row of nodeRows) {
        const entry = byTs.get(row.ts) ?? { cpu: [], ramUsed: 0, ramTotal: 0, gpu: {} };
        if (row.cpu_pct != null) entry.cpu.push(Number(row.cpu_pct));
        entry.ramUsed += Number(row.mem_used_kb ?? 0);
        entry.ramTotal += Number(row.mem_total_kb ?? 0);
        if (row.avg_util != null) entry.gpu[row.node] = Number(row.avg_util);
        byTs.set(row.ts, entry);
      }

      const points: UsagePoint[] = [...byTs.entries()].map(([ts, e]) => ({
        t: new Date(`${ts}+05:30`).getTime(),
        cpu: e.cpu.length ? Math.round((e.cpu.reduce((a, b) => a + b, 0) / e.cpu.length) * 10) / 10 : 0,
        ram: e.ramTotal ? Math.round((e.ramUsed / e.ramTotal) * 1000) / 10 : 0,
        gpu01: e.gpu['gpu01'] ?? 0,
        gpu02: e.gpu['gpu02'] ?? 0,
      }));
      if (points.length) this.history.set(points.slice(-300));

      const perGpu: Record<string, number[]> = {};
      for (const row of gpuRows) {
        const key = `${row.node}:${row.gpu_index}`;
        (perGpu[key] ??= []).push(Number(row.util_pct ?? 0));
      }
      if (Object.keys(perGpu).length) this.gpuHistory.set(perGpu);
    } catch {
      // history is a nicety; live pushes still drive the charts
    }
  }

  private connect(): void {
    try {
      this.socket = new WebSocket(this.wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.socket.onopen = () => {
      this.connected.set(true);
      this.reconnectDelay = 1000;
    };

    this.socket.onmessage = (event: MessageEvent<string>) => {
      let msg: HelloMessage | SnapshotMessage;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        if (msg.snapshot) this.applySnapshot(msg.snapshot);
        return;
      }
      if (msg.type === 'snapshot') {
        this.applySnapshot(msg.snapshot);
        this.alerts.update((existing) => [...msg.alerts, ...existing].slice(0, 30));
      }
    };

    this.socket.onclose = () => {
      this.connected.set(false);
      this.scheduleReconnect();
    };

    this.socket.onerror = () => this.socket?.close();
  }

  private scheduleReconnect(): void {
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(delay * 2, 15000);
    if (typeof window !== 'undefined') {
      window.setTimeout(() => this.connect(), delay);
    }
  }

  private applySnapshot(snapshot: ClusterSnapshot): void {
    this.snapshot.set(snapshot);
    this.pushHistoryPoint(snapshot);
    // Collector sends jobs: null when unchanged; the API inherits, but guard here too.
    if (Array.isArray(snapshot.jobs)) this.jobs.set(snapshot.jobs);
    this.lastPushAt.set(Date.now());
  }

  private pushHistoryPoint(snapshot: ClusterSnapshot): void {
    const t = snapshot.totals;
    if (!t) return;
    const avgGpu = (nodeName: string): number => {
      const node = (snapshot.nodes ?? []).find((n) => n?.node === nodeName);
      const gpus = node?.gpus ?? [];
      if (!gpus.length) return 0;
      const util = gpus.reduce((sum, g) => sum + (g.util_pct ?? 0), 0) / gpus.length;
      return Math.round(util * 10) / 10;
    };
    const nodes = (snapshot.nodes ?? []).filter((n): n is NonNullable<typeof n> => !!n);
    const cpuSamples = nodes.map((n) => n.cpu?.used_pct).filter((v): v is number => typeof v === 'number');
    const ramUsed = nodes.reduce((sum, n) => sum + (n.mem?.used_kb ?? 0), 0);
    const ramTotal = nodes.reduce((sum, n) => sum + (n.mem?.total_kb ?? 0), 0);
    const point: UsagePoint = {
      t: new Date(snapshot.ingest_ts).getTime(),
      cpu: cpuSamples.length
        ? Math.round((cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length) * 10) / 10
        : 0,
      ram: ramTotal ? Math.round((ramUsed / ramTotal) * 1000) / 10 : 0,
      gpu01: avgGpu('gpu01'),
      gpu02: avgGpu('gpu02'),
    };
    this.gpuHistory.update((current) => {
      const next: Record<string, number[]> = { ...current };
      for (const node of nodes) {
        for (const gpu of node.gpus ?? []) {
          const key = `${node.node}:${gpu.index}`;
          const series = [...(next[key] ?? []), gpu.util_pct ?? 0];
          next[key] = series.length > 120 ? series.slice(series.length - 120) : series;
        }
      }
      return next;
    });

    this.history.update((points) => {
      const next = [...points, point];
      // 5 minutes at ~1 Hz, trimmed so memory stays flat during long demos.
      return next.length > 300 ? next.slice(next.length - 300) : next;
    });
  }

  /** Load ratio per node, so the UI can colour above 1.0 (gpu01 really hits 1.6x). */
  loadRatio(node: NodeSample): number {
    const cores = node.cpu?.logical ?? 0;
    const load = node.loadavg?.[0];
    return cores && typeof load === 'number' ? load / cores : 0;
  }

  gbFromKb(kb: number | null | undefined): number {
    return Math.round(((kb ?? 0) / 1048576) * 10) / 10;
  }
}
