import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ClusterPulseService } from '../core/cluster-pulse.service';
import { Job, NodeSample } from '../core/models';
import { GpuSparklines } from './gpu-sparklines';
import { UsageChart } from './usage-chart';

@Component({
  selector: 'app-overview',
  imports: [UsageChart, GpuSparklines],
  templateUrl: './overview.html',
  styleUrl: './overview.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Overview {
  private readonly feed = inject(ClusterPulseService);

  readonly snapshot = this.feed.snapshot;
  readonly connected = this.feed.connected;
  readonly staleness = this.feed.staleness;
  readonly alerts = this.feed.alerts;
  readonly jobs = this.feed.jobs;
  readonly history = this.feed.history;
  readonly gpuHistory = this.feed.gpuHistory;
  readonly cpuUsedPct = this.feed.cpuUsedPct;
  readonly ramUsedGb = this.feed.ramUsedGb;
  readonly ramTotalGb = this.feed.ramTotalGb;
  readonly gpuAvgUtil = this.feed.gpuAvgUtil;

  readonly gpusFree = this.feed.gpusFree;
  readonly jobsRunning = this.feed.jobsRunning;
  readonly jobsQueued = this.feed.jobsQueued;
  readonly cpuPct = this.feed.cpuPct;
  readonly ramPct = this.feed.ramPct;

  readonly totals = this.feed.totals;
  readonly queueNames = computed(() => Object.keys(this.feed.queues()));

  /** Nodes with live sampler data only — a missing sampler must look absent, not zero. */
  readonly liveNodes = computed(() =>
    (this.snapshot()?.nodes ?? []).filter((n): n is NodeSample => !!n),
  );

  readonly runningJobs = computed(() =>
    [...this.jobs()]
      .filter((j) => j.state === 'R')
      .sort((a, b) => Number(b.cpupercent ?? 0) - Number(a.cpupercent ?? 0))
      .slice(0, 12),
  );

  readonly queuedCount = computed(() => this.jobs().filter((j) => j.state === 'Q').length);

  readonly fresh = computed(() => this.connected() && this.staleness() <= 5);

  /** Templates need Math for the clamped bars. */
  protected readonly Math = Math;

  loadRatio(node: NodeSample): number {
    return this.feed.loadRatio(node);
  }

  loadColour(node: NodeSample): string {
    const ratio = this.loadRatio(node);
    if (ratio < 0.7) return 'var(--green)';
    if (ratio <= 1) return 'var(--amber)';
    return 'var(--red)';
  }

  gb(kb: number | null | undefined): number {
    return this.feed.gbFromKb(kb);
  }

  /** Job stress bar width: cpupercent can exceed 100 on a multithreaded job. */
  stressWidth(cpupercent: number | null | undefined): number {
    return Math.min((cpupercent ?? 0) / 2, 100);
  }

  stressColour(cpupercent: number | null | undefined): string {
    const value = cpupercent ?? 0;
    if (value >= 400) return 'var(--red)';
    if (value >= 100) return 'var(--amber)';
    return 'var(--blue)';
  }

  trackNode = (_: number, node: NodeSample) => node.node;
  trackGpu = (_: number, gpu: { index: number }) => gpu.index;
  trackJob = (_: number, job: Job) => job.id;
}
