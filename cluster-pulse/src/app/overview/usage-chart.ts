import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { UsagePoint } from '../core/models';

interface Series {
  key: keyof Omit<UsagePoint, 't'>;
  label: string;
  colour: string;
  points: string;
  latest: number;
}

const WIDTH = 640;
const HEIGHT = 170;
const PAD = { top: 10, right: 8, bottom: 18, left: 30 };

/**
 * Rolling multi-series chart (Task-Manager style): cluster CPU, RAM and average
 * GPU utilisation per node over the last few minutes.
 *
 * Values are percentages of the *allocated* capacity for CPU/RAM (that is what
 * PBS reports) and node-wide utilisation for GPUs. Both are clamped to 0..100
 * because a load average can exceed core count — that lives in the node header,
 * not here, so the axis stays honest.
 */
@Component({
  selector: 'app-usage-chart',
  imports: [],
  templateUrl: './usage-chart.html',
  styleUrl: './usage-chart.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UsageChart {
  readonly points = input<UsagePoint[]>([]);
  readonly seriesKeys: { key: keyof Omit<UsagePoint, 't'>; label: string; colour: string }[] = [
    { key: 'cpu', label: 'CPU', colour: 'var(--blue)' },
    { key: 'ram', label: 'RAM', colour: 'var(--green)' },
    { key: 'gpu01', label: 'GPU gpu01', colour: 'var(--amber)' },
    { key: 'gpu02', label: 'GPU gpu02', colour: 'var(--red)' },
  ];

  readonly width = WIDTH;
  readonly height = HEIGHT;
  readonly plot = {
    x: PAD.left,
    y: PAD.top,
    w: WIDTH - PAD.left - PAD.right,
    h: HEIGHT - PAD.top - PAD.bottom,
  };
  readonly gridLines = [0, 25, 50, 75, 100];

  readonly series = computed<Series[]>(() => {
    const pts = this.points();
    if (pts.length < 2) return [];

    const t0 = pts[0].t;
    const t1 = pts[pts.length - 1].t;
    const span = Math.max(t1 - t0, 1);
    const clamp = (v: number) => Math.max(0, Math.min(100, v));

    return this.seriesKeys.map(({ key, label, colour }) => {
      const coords = pts.map((p) => {
        const x = this.plot.x + ((p.t - t0) / span) * this.plot.w;
        const y = this.plot.y + this.plot.h - (clamp(p[key]) / 100) * this.plot.h;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      });
      return {
        key,
        label,
        colour,
        points: coords.join(' '),
        latest: Math.round(clamp(pts[pts.length - 1][key]) * 10) / 10,
      };
    });
  });

  yFor(value: number): number {
    return this.plot.y + this.plot.h - (value / 100) * this.plot.h;
  }

  readonly windowLabel = computed(() => {
    const pts = this.points();
    if (pts.length < 2) return 'waiting for data';
    const seconds = Math.round((pts[pts.length - 1].t - pts[0].t) / 1000);
    return `last ${Math.floor(seconds / 60)}m ${seconds % 60}s · ${pts.length} points`;
  });
}
