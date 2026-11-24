import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ClusterPulseService } from '../core/cluster-pulse.service';
import { Job } from '../core/models';
import { JqueryJobTable } from './jquery-job-table';

type StateFilter = 'all' | 'R' | 'Q' | 'H';

@Component({
  selector: 'app-jobs',
  imports: [JqueryJobTable],
  templateUrl: './jobs.html',
  styleUrl: './jobs.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Jobs {
  private readonly feed = inject(ClusterPulseService);

  readonly jobs = this.feed.jobs;
  readonly connected = this.feed.connected;
  readonly stateFilter = signal<StateFilter>('all');
  readonly queueFilter = signal<string>('all');
  readonly search = signal<string>('');

  readonly queues = computed(() => {
    const set = new Set<string>();
    for (const job of this.jobs()) if (job.queue) set.add(job.queue);
    return ['all', ...[...set].sort()];
  });

  readonly counts = computed(() => {
    const all = this.jobs();
    return {
      all: all.length,
      R: all.filter((j) => j.state === 'R').length,
      Q: all.filter((j) => j.state === 'Q').length,
      H: all.filter((j) => j.state === 'H').length,
    };
  });

  readonly filtered = computed<Job[]>(() => {
    const state = this.stateFilter();
    const queue = this.queueFilter();
    const term = this.search().trim().toLowerCase();
    return this.jobs()
      .filter((job) => state === 'all' || job.state === state)
      .filter((job) => queue === 'all' || job.queue === queue)
      .filter((job) => {
        if (!term) return true;
        return [job.id, job.name, job.owner, job.exec_host]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(term));
      })
      .sort((a, b) => Number(b.cpupercent ?? 0) - Number(a.cpupercent ?? 0));
  });

  setState(value: StateFilter): void {
    this.stateFilter.set(value);
  }

  setQueue(event: Event): void {
    this.queueFilter.set((event.target as HTMLSelectElement).value);
  }

  setSearch(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  gb(kb: number | null | undefined): string {
    if (kb == null) return '—';
    return `${(kb / 1048576).toFixed(1)} GB`;
  }

  stressWidth(cpupercent: number | null | undefined): number {
    return Math.min((cpupercent ?? 0) / 2, 100);
  }

  stressColour(cpupercent: number | null | undefined): string {
    const value = cpupercent ?? 0;
    if (value >= 400) return 'var(--red)';
    if (value >= 100) return 'var(--amber)';
    return 'var(--blue)';
  }
}
