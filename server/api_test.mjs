// End-to-end test for the Cluster Pulse API: boots the server, POSTs a real
// cluster snapshot, checks REST + WebSocket delivery, then shuts down.
import { spawn } from 'node:child_process';

const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

const server = spawn(process.execPath, ['src/server.js'], {
  cwd: new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bootLog = '';
server.stdout.on('data', (d) => (bootLog += d));
server.stderr.on('data', (d) => (bootLog += d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return await res.json();
    } catch {}
    await sleep(250);
  }
  throw new Error('server never became healthy:\n' + bootLog);
}

const gpu = (i, util, mem, temp) => ({
  index: i, name: 'NVIDIA H100 80GB HBM3', util_pct: util,
  mem_used_mib: mem, mem_total_mib: 81559, temp_c: temp, power_w: 300.5,
});

const snapshot = {
  schema: 1, type: 'cluster_snapshot', ingest_ts: new Date().toISOString(),
  pbs_refreshed_s_ago: 0.2, clock_note: 'node clocks ~11min behind mgmt01',
  totals: { gpus: 16, gpus_alloc: 16, cores: 208, cores_alloc: 171, mem_kb: 2112097032, mem_alloc_kb: 1221591040 },
  queues: { workq: { running: 5, queued: 0, held: 3 }, gpu: { running: 22, queued: 14, held: 26 } },
  nodes: [
    { schema: 1, type: 'node_sample', node: 'gpu01', node_ts: '2026-11-20T16:09:41+05:30',
      loadavg: [170.3, 169.7, 163.88], cpu: { logical: 104 },
      mem: { total_kb: 1056047776, available_kb: 708075336, used_kb: 347972440 },
      gpus: [gpu(0, 97, 28690, 53), gpu(1, 71, 48503, 59), gpu(3, 100, 76615, 82)],
      apps: [{ gpu_index: 0, pid: 3194983, process: 'python3', user: 'parth.14353', mem_mib: 28678 }] },
    { schema: 1, type: 'node_sample', node: 'gpu02', node_ts: '2026-11-20T16:09:42+05:30',
      loadavg: [22.17, 22.87, 23.82], cpu: { logical: 104 },
      mem: { total_kb: 1056049216, available_kb: 877047536, used_kb: 179001680 },
      gpus: [gpu(0, 100, 77587, 68)], apps: [] },
  ],
  pbs_nodes: [], jobs: [{ id: '47652', name: 'cp_sampler', owner: 'arun.26025', queue: 'gpu', state: 'R', ncpus: 1, ngpus: null }],
};

try {
  const health = await waitForHealth();
  check('GET /health returns ok', health.ok === true, `db=${health.db}`);
  check('health reports gpu attribution caveat', /node-wide/.test(health.gpu_attribution));

  // WebSocket must be connected BEFORE ingest to prove push delivery.
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/stream`);
  const messages = [];
  const wsReady = new Promise((resolve, reject) => {
    ws.onmessage = (ev) => messages.push(JSON.parse(ev.data));
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(new Error('ws error ' + e.message));
    setTimeout(() => reject(new Error('ws timeout')), 8000);
  });
  await wsReady;
  await sleep(200);
  check('WS greeting received', messages.some((m) => m.type === 'hello'));

  const post1 = await fetch(`${BASE}/api/ingest/cluster`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot),
  });
  const post1Body = await post1.json();
  check('POST /api/ingest/cluster accepted', post1.status === 200 && post1Body.ok === true,
    `clients=${post1Body.clients} alerts=${post1Body.alerts}`);

  await sleep(400);
  const pushed = messages.find((m) => m.type === 'snapshot');
  check('WS pushed the snapshot to the browser', !!pushed);
  check('pushed payload carries both nodes', pushed?.snapshot?.nodes?.length === 2);
  check('overload alert fired for gpu01 (load 1.64x)', 
    (pushed?.alerts || []).some((a) => a.kind === 'node_overload' && a.node === 'gpu01'),
    JSON.stringify((pushed?.alerts || []).map((a) => a.kind + ':' + a.subject)));
  check('gpu temp alert fired at 82C',
    (pushed?.alerts || []).some((a) => a.kind === 'gpu_temp' && a.subject === 'gpu01.gpu3'));
  check('no false overload alert for gpu02 (0.21x)',
    !(pushed?.alerts || []).some((a) => a.kind === 'node_overload' && a.node === 'gpu02'));

  const snapRes = await fetch(`${BASE}/api/snapshot`);
  const snapBody = await snapRes.json();
  check('GET /api/snapshot returns latest', snapRes.status === 200 && snapBody.snapshot?.totals?.cores === 208);

  const badRes = await fetch(`${BASE}/api/ingest/cluster`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'nope' }),
  });
  check('rejects malformed payload with 400', badRes.status === 400);

  const histRes = await fetch(`${BASE}/api/history?minutes=5`);
  check('history degrades cleanly without MySQL', histRes.status === 503,
    (await histRes.json()).error?.slice(0, 40));

  const health2 = await (await fetch(`${BASE}/health`)).json();
  check('ingest counter advanced', health2.ingest_count >= 1, `count=${health2.ingest_count}`);

  // Collector slimming contract: jobs:null must inherit the previous list,
  // not wipe it in the browser or the DB.
  const lean = { ...snapshot, jobs: null, ingest_ts: new Date().toISOString() };
  const leanRes = await fetch(`${BASE}/api/ingest/cluster`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(lean),
  });
  check('accepts jobs:null (unchanged) payload', leanRes.status === 200);
  await sleep(200);
  const lastPush = messages.filter((m) => m.type === 'snapshot').pop();
  check('jobs:null inherits previous job list', lastPush?.snapshot?.jobs?.length === 1,
    `jobs=${lastPush?.snapshot?.jobs?.length} state=${lastPush?.snapshot?.jobs_state}`);
  ws.close();
} catch (err) {
  check('test harness completed without throwing', false, err.message);
} finally {
  server.kill();
  await sleep(300);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
