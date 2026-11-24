import { ChangeDetectionStrategy, Component, OnDestroy, inject, signal } from '@angular/core';
import { ClusterPulseService } from '../core/cluster-pulse.service';

interface LogRow {
  ts: string;
  source: string;
  ref: string;
  message: string;
  detail: string | null;
}

/**
 * Scheduler + alert log. These rows come from MySQL (job_event and alert), which
 * is what makes this screen survive a WebSocket gap — the live feed table shows
 * current state, this one shows what happened.
 */
@Component({
  selector: 'app-logs',
  imports: [],
  templateUrl: './logs.html',
  styleUrl: './logs.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Logs implements OnDestroy {
  private readonly feed = inject(ClusterPulseService);
  private timer: number | null = null;

  readonly rows = signal<LogRow[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly filter = signal<'all' | 'job_event' | 'alert'>('all');

  readonly connected = this.feed.connected;

  constructor() {
    this.load();
    if (typeof window !== 'undefined') {
      this.timer = window.setInterval(() => this.load(), 10000);
    }
  }

  ngOnDestroy(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
  }

  private async load(): Promise<void> {
    try {
      const res = await fetch('http://localhost:3000/api/logs?limit=200');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        this.error.set(body?.error ?? `HTTP ${res.status}`);
        this.loading.set(false);
        return;
      }
      const body = await res.json();
      this.rows.set(body.rows ?? []);
      this.error.set(null);
    } catch {
      this.error.set('API unreachable — is the Node server running?');
    } finally {
      this.loading.set(false);
    }
  }

  visible(): LogRow[] {
    const f = this.filter();
    return f === 'all' ? this.rows() : this.rows().filter((r) => r.source === f);
  }

  setFilter(value: 'all' | 'job_event' | 'alert'): void {
    this.filter.set(value);
  }

  countFor(source: 'job_event' | 'alert'): number {
    return this.rows().filter((r) => r.source === source).length;
  }

  refresh(): void {
    this.loading.set(true);
    void this.load();
  }
}
