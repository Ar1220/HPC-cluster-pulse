// Wire contracts shared with the collector on mgmt01 (see cluster/README.md).

export interface GpuSample {
  index: number;
  name: string;
  util_pct: number | null;
  mem_used_mib: number | null;
  mem_total_mib: number | null;
  temp_c: number | null;
  power_w: number | null;
}

export interface GpuApp {
  gpu_index: number | null;
  pid: number | null;
  process: string;
  user: string | null;
  mem_mib: number | null;
}

export interface NodeSample {
  node: string;
  node_ts: string;
  uptime_s: number | null;
  loadavg: (number | null)[];
  cpu: { logical: number | null; used_pct?: number | null };
  mem: { total_kb: number | null; available_kb: number | null; used_kb: number | null };
  gpus: GpuSample[];
  apps?: GpuApp[];
  apps_omitted?: boolean;
  pbs_job_id?: string | null;
  cuda_visible_devices?: string;
}

export interface Job {
  id: string;
  name: string | null;
  owner: string | null;
  queue: string | null;
  state: string | null;
  ncpus: number | null;
  ngpus: number | null;
  mem: string | null;
  walltime_limit: string | null;
  walltime_used: string | null;
  exec_host: string | null;
  /** Actual consumption from PBS resources_used — not the request. */
  cpupercent?: number | null;
  mem_used_kb?: number | null;
  cput?: string | null;
}

/** One point of the rolling chart window. */
export interface UsagePoint {
  t: number;
  cpu: number;
  ram: number;
  gpu01: number;
  gpu02: number;
}

export interface ClusterSnapshot {
  schema: number;
  type: 'cluster_snapshot';
  ingest_ts: string;
  pbs_refreshed_s_ago: number;
  clock_note: string;
  totals: {
    gpus: number;
    gpus_alloc: number;
    cores: number;
    cores_alloc: number;
    mem_kb: number;
    mem_alloc_kb: number;
  };
  queues: Record<string, { running: number; queued: number; held: number }>;
  nodes: (NodeSample | null)[];
  pbs_nodes: unknown[];
  jobs: Job[] | null;
  jobs_state?: string;
}

export interface Alert {
  kind: string;
  node: string | null;
  subject: string;
  message: string;
  ts?: string;
}

export interface SnapshotMessage {
  type: 'snapshot';
  snapshot: ClusterSnapshot;
  alerts: Alert[];
  received_at: string;
}

export interface HelloMessage {
  type: 'hello';
  snapshot: ClusterSnapshot | null;
  nodes: NodeSample[];
}
