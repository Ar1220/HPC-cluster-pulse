import { ChangeDetectionStrategy, Component, OnDestroy, OnInit } from '@angular/core';
import $ from 'jquery';

/**
 * Legacy jQuery view — kept deliberately separate from the Angular data flow.
 *
 * The web-tech requirement asks for Angular *and* jQuery in the same project.
 * This component is the jQuery half: it ignores the WebSocket entirely and polls
 * the REST endpoint with $.ajax every 5 seconds, then builds the table with DOM
 * manipulation. It is the same data by a different transport, which is also a
 * useful fallback if the socket path ever breaks during a demo.
 */
@Component({
  selector: 'app-jquery-job-table',
  imports: [],
  template: `
    <section class="card jq">
      <div class="head">
        <strong>JQUERY VIEW</strong>
        <small>$.ajax polling every 5 s · independent of the WebSocket feed</small>
      </div>
      <div class="status" id="jq-status">starting…</div>
      <table>
        <thead>
          <tr>
            <th>ID</th><th>NAME</th><th>OWNER</th><th>QUEUE</th><th>STATE</th>
            <th>CPUS</th><th>GPUS</th><th>CPU %</th><th>MEM (GB)</th><th>HOST</th>
          </tr>
        </thead>
        <tbody id="jq-body">
          <tr><td colspan="10" class="dim">waiting for first poll…</td></tr>
        </tbody>
      </table>
    </section>
  `,
  styleUrl: './jquery-job-table.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class JqueryJobTable implements OnInit, OnDestroy {
  private timer: number | null = null;

  ngOnInit(): void {
    this.fetch();
    this.timer = window.setInterval(() => this.fetch(), 5000);
  }

  ngOnDestroy(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
  }

  private fetch(): void {
    $.ajax({
      url: 'http://localhost:3000/api/snapshot',
      dataType: 'json',
      timeout: 4000,
    })
      .done((data: any) => {
        const jobs: any[] = Array.isArray(data?.snapshot?.jobs) ? data.snapshot.jobs : [];
        const age = data?.last_snapshot_ago_s;
        $('#jq-status').text(
          `polled ${new Date().toLocaleTimeString()} · ${jobs.length} jobs · feed ${age ?? '?'}s old`,
        );

        if (!jobs.length) {
          $('#jq-body').html('<tr><td colspan="10" class="dim">no jobs in the last snapshot</td></tr>');
          return;
        }

        const rows = jobs
          .slice()
          .sort((a, b) => Number(b.cpupercent ?? 0) - Number(a.cpupercent ?? 0))
          .slice(0, 15)
          .map((job) => {
            const memGb = job.mem_used_kb ? (job.mem_used_kb / 1048576).toFixed(1) : '—';
            const cpu = job.cpupercent != null ? `${job.cpupercent}%` : '—';
            const stateClass = job.state ?? '';
            return (
              '<tr>' +
              `<td>${job.id ?? ''}</td>` +
              `<td>${job.name ?? ''}</td>` +
              `<td class="dim">${job.owner ?? ''}</td>` +
              `<td>${job.queue ?? ''}</td>` +
              `<td class="${stateClass}">${job.state ?? ''}</td>` +
              `<td>${job.ncpus ?? '—'}</td>` +
              `<td>${job.ngpus ?? '—'}</td>` +
              `<td>${cpu}</td>` +
              `<td>${memGb}</td>` +
              `<td class="dim">${job.exec_host ?? ''}</td>` +
              '</tr>'
            );
          })
          .join('');

        $('#jq-body').html(rows || '<tr><td colspan="10" class="dim">no jobs</td></tr>');
      })
      .fail(() => {
        $('#jq-status').text(`poll failed at ${new Date().toLocaleTimeString()} — API not answering`);
      });
  }
}
