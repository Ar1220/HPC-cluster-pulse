import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ClusterPulseService } from './core/cluster-pulse.service';

@Component({
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly feed = inject(ClusterPulseService);

  readonly connected = this.feed.connected;
  readonly staleness = this.feed.staleness;
  readonly fresh = computed(() => this.connected() && this.staleness() <= 5);
  readonly ingestTs = computed(() => this.feed.snapshot()?.ingest_ts ?? 'no data yet');
}
