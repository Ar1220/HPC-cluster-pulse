import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

interface Spark {
  key: string;
  node: string;
  index: number;
  value: number;
  points: string;
  colour: string;
}

/**
 * One 60-second sparkline per GPU (16 tiles, 8 per node) — the per-core grid from
 * Task Manager, applied to H100s.
 *
 * The numbers are node-wide utilisation: PBS does not isolate GPUs on this
 * cluster, so a tile includes every user's work on that device.
 */
@Component({
  selector: 'app-gpu-sparklines',
  imports: [],
  templateUrl: './gpu-sparklines.html',
  styleUrl: './gpu-sparklines.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GpuSparklines {
  readonly data = input<Record<string, number[]>>({});
  readonly nodes = input<string[]>(['gpu01', 'gpu02']);
  readonly gpusPerNode = input<number>(8);

  private readonly W = 100;
  private readonly H = 26;

  readonly rows = computed(() => {
    const data = this.data();
    const nodeList = this.nodes();
    const count = this.gpusPerNode();

    return nodeList.map((node) => {
      const tiles: Spark[] = [];
      for (let i = 0; i < count; i++) {
        const key = `${node}:${i}`;
        const series = data[key] ?? [];
        const last = series.length ? series[series.length - 1] : 0;
        tiles.push({
          key,
          node,
          index: i,
          value: Math.round(last),
          points: this.path(series),
          colour: last >= 90 ? 'var(--red)' : last >= 50 ? 'var(--amber)' : 'var(--blue)',
        });
      }
      return { node, tiles };
    });
  });

  private path(series: number[]): string {
    if (series.length < 2) return '';
    const max = 100;
    const step = this.W / (series.length - 1);
    return series
      .map((value, i) => {
        const x = i * step;
        const y = this.H - (Math.max(0, Math.min(max, value)) / max) * this.H;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }
}
