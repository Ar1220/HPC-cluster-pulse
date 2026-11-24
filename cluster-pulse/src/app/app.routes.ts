import { Routes } from '@angular/router';
import { Jobs } from './jobs/jobs';
import { Logs } from './logs/logs';
import { Nodes } from './nodes/nodes';
import { Overview } from './overview/overview';

export const routes: Routes = [
  { path: '', component: Overview, title: 'Cluster Pulse — Overview' },
  { path: 'nodes', component: Nodes, title: 'Cluster Pulse — Nodes' },
  { path: 'jobs', component: Jobs, title: 'Cluster Pulse — Jobs' },
  { path: 'logs', component: Logs, title: 'Cluster Pulse — Logs' },
  { path: '**', redirectTo: '' },
];
