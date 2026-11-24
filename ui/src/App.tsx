import { useEffect, useMemo, useState } from "react";

type IconName =
  | "activity"
  | "server"
  | "layers"
  | "list"
  | "settings"
  | "search"
  | "chevron"
  | "close"
  | "filter"
  | "clock"
  | "terminal"
  | "arrow"
  | "more";

type StatusTone = "online" | "warning" | "critical" | "neutral";
type Screen = "overview" | "nodes" | "jobs" | "logs" | "settings";

const navItems: { id: Screen; label: string; icon: IconName }[] = [
  { id: "overview", label: "Overview", icon: "activity" },
  { id: "nodes", label: "Nodes", icon: "server" },
  { id: "jobs", label: "Jobs", icon: "layers" },
  { id: "logs", label: "Logs", icon: "list" },
  { id: "settings", label: "Settings", icon: "settings" },
];

const linePaths = {
  cpu: "M0 87 L18 83 L36 93 L54 76 L72 80 L90 62 L108 69 L126 50 L144 57 L162 39 L180 53 L198 37 L216 46 L234 31 L252 45 L270 33 L288 50 L306 44 L324 59 L342 41 L360 51 L378 35 L396 46 L414 27 L432 39 L450 22 L468 33 L486 28 L504 48 L522 36 L540 40 L558 21 L576 30 L594 24 L612 44 L630 36 L648 49 L666 38 L684 43 L702 25 L720 32 L738 20 L756 26 L774 17 L792 27",
  ram: "M0 108 L18 106 L36 111 L54 100 L72 97 L90 93 L108 102 L126 95 L144 91 L162 88 L180 89 L198 83 L216 87 L234 79 L252 82 L270 72 L288 76 L306 71 L324 74 L342 68 L360 70 L378 64 L396 67 L414 59 L432 65 L450 58 L468 62 L486 55 L504 60 L522 53 L540 56 L558 48 L576 52 L594 44 L612 50 L630 43 L648 47 L666 42 L684 44 L702 37 L720 40 L738 34 L756 39 L774 31 L792 36",
};

const gpuNodes = [
  {
    name: "gpu01",
    cores: "96 / 104",
    ram: "738 / 1,024 GB",
    load: "8.42",
    state: "online" as StatusTone,
    gpus: [
      [94, "74 / 80 GB", "77°C"],
      [87, "69 / 80 GB", "75°C"],
      [82, "64 / 80 GB", "72°C"],
      [75, "58 / 80 GB", "69°C"],
      [91, "72 / 80 GB", "78°C"],
      [68, "54 / 80 GB", "66°C"],
      [5, "1 / 80 GB", "34°C"],
      [0, "0 / 80 GB", "31°C"],
    ],
  },
  {
    name: "gpu02",
    cores: "88 / 104",
    ram: "704 / 1,024 GB",
    load: "7.16",
    state: "online" as StatusTone,
    gpus: [
      [98, "78 / 80 GB", "80°C"],
      [90, "72 / 80 GB", "77°C"],
      [84, "66 / 80 GB", "73°C"],
      [96, "76 / 80 GB", "79°C"],
      [74, "59 / 80 GB", "68°C"],
      [88, "70 / 80 GB", "76°C"],
      [81, "65 / 80 GB", "71°C"],
      [92, "73 / 80 GB", "78°C"],
    ],
  },
];

const nodes = [
  ["gpu01", "online", "96 / 104", "738 / 1 TB", "6 / 8", "8.42", "18d 04h"],
  ["gpu02", "online", "88 / 104", "704 / 1 TB", "8 / 8", "7.16", "18d 04h"],
];

const jobs = [
  [
    "741829",
    "vllm_serve",
    "m.chen",
    "gpu",
    "running",
    "64",
    "4",
    "384 GB",
    "01:17:22 / 08:00:00",
    "01:17:22",
  ],
  [
    "741827",
    "reid_training",
    "a.rahman",
    "workq",
    "running",
    "128",
    "0",
    "460 GB",
    "02:48:10 / 12:00:00",
    "02:48:10",
  ],
  [
    "741825",
    "qwen2.5_sft",
    "j.williams",
    "gpu",
    "running",
    "128",
    "8",
    "480 GB",
    "06:13:42 / 24:00:00",
    "06:13:42",
  ],
  [
    "741820",
    "brain_stroke_train",
    "s.ortiz",
    "workq",
    "queued",
    "96",
    "0",
    "768 GB",
    "00:00:00 / 04:00:00",
    "—",
  ],
  [
    "741816",
    "llama_server",
    "n.patel",
    "gpu",
    "queued",
    "32",
    "2",
    "128 GB",
    "00:00:00 / 02:00:00",
    "—",
  ],
];

const logLines = [
  {
    time: "14:32:09.183",
    level: "INFO",
    node: "mgmt01",
    text: "job 741829 allocation confirmed: gpu01",
    source: "slurmctld",
  },
  {
    time: "14:31:54.024",
    level: "WARN",
    node: "gpu02",
    text: "temperature threshold approaching on GPU 0 (80°C)",
    source: "node-watch",
  },
  {
    time: "14:31:48.760",
    level: "INFO",
    node: "gpu01",
    text: "epilog complete for job 741794",
    source: "slurmd",
  },
  {
    time: "14:31:40.339",
    level: "INFO",
    node: "gpu01",
    text: "GPU 7 returned to the free pool after job epilog",
    source: "node-watch",
  },
  {
    time: "14:31:33.001",
    level: "INFO",
    node: "mgmt01",
    text: "lustre OST pool utilization: 64.2%",
    source: "storage",
  },
  {
    time: "14:31:20.414",
    level: "DEBUG",
    node: "mgmt01",
    text: "backfill cycle completed in 182 ms",
    source: "slurmctld",
  },
  {
    time: "14:31:13.620",
    level: "INFO",
    node: "gpu02",
    text: "job 741821 task 0 exited with status 0",
    source: "slurmd",
  },
];

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  const paths: Record<IconName, React.ReactNode> = {
    activity: (
      <>
        <path d="M3 12h4l3-7 4 14 3-7h4" />
      </>
    ),
    server: (
      <>
        <rect x="3" y="3" width="18" height="7" rx="1" />
        <rect x="3" y="14" width="18" height="7" rx="1" />
        <path d="M7 6.5h.01M7 17.5h.01" />
      </>
    ),
    layers: (
      <>
        <path d="m12 3 9 5-9 5-9-5 9-5Z" />
        <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
      </>
    ),
    list: (
      <>
        <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.12 2.12-.06-.06A1.7 1.7 0 0 0 15.74 18a1.7 1.7 0 0 0-1 1.55v.09h-3v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.88.34l-.06.06-2.12-2.12.06-.06A1.7 1.7 0 0 0 7 15a1.7 1.7 0 0 0-1.55-1H5.36v-3h.09A1.7 1.7 0 0 0 7 10a1.7 1.7 0 0 0-.34-1.88L6.6 8.06l2.12-2.12.06.06A1.7 1.7 0 0 0 10.66 6a1.7 1.7 0 0 0 1-1.55v-.09h3v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.12 2.12-.06.06A1.7 1.7 0 0 0 19 10a1.7 1.7 0 0 0 1.55 1h.09v3h-.09A1.7 1.7 0 0 0 19.4 15Z" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="6.5" />
        <path d="m16 16 4.25 4.25" />
      </>
    ),
    chevron: <path d="m8 10 4 4 4-4" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    filter: (
      <>
        <path d="M4 6h16M7 12h10M10 18h4" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7v5l3.5 2" />
      </>
    ),
    terminal: (
      <>
        <path d="m5 7 4 4-4 4M12 17h7" />
      </>
    ),
    arrow: (
      <>
        <path d="M5 12h13M14 7l5 5-5 5" />
      </>
    ),
    more: (
      <>
        <circle cx="5" cy="12" r="1" fill="currentColor" />
        <circle cx="12" cy="12" r="1" fill="currentColor" />
        <circle cx="19" cy="12" r="1" fill="currentColor" />
      </>
    ),
  };
  return (
    <svg {...common} aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function StatusPill({
  tone = "neutral",
  children,
}: {
  tone?: StatusTone;
  children: React.ReactNode;
}) {
  return (
    <span className={`status-pill ${tone}`}>
      <span className="status-dot" />
      {children}
    </span>
  );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <section className={`panel ${className}`}>{children}</section>;
}

function ConnectionStatus() {
  const [open, setOpen] = useState(false);
  return (
    <div className="connection-wrap">
      <button className="connection" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="live-dot" /> Connected <Icon name="chevron" size={15} />
      </button>
      {open && (
        <div className="connection-menu">
          <span>
            <i className="green-dot" /> head.cm.ddn.upes.ac.in
          </span>
          <span className="connection-code">ws://localhost:3000/stream</span>
          <button onClick={() => setOpen(false)}>Dismiss</button>
        </div>
      )}
    </div>
  );
}

function Header({ screen }: { screen: Screen }) {
  const label = navItems.find((item) => item.id === screen)?.label ?? "Overview";
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setTime(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <header className="topbar">
      <div className="header-title">
        <div className="mobile-brand">CP</div>
        <div>
          <div className="breadcrumb">
            <span>Cluster Pulse</span>
            <b>/</b>
            <span>{label}</span>
          </div>
          <h1>{label}</h1>
        </div>
      </div>
      <div className="header-meta">
        <ConnectionStatus />
        <span className="time-stamp">
          <Icon name="clock" size={15} /> {time.toISOString().slice(11, 19)} UTC
        </span>
      </div>
    </header>
  );
}

function Sidebar({ screen, onChange }: { screen: Screen; onChange: (screen: Screen) => void }) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <span />
          <span />
          <span />
        </div>
        <span>
          CLUSTER
          <br />
          <b>PULSE</b>
        </span>
      </div>
      <div className="cluster-chip">
        <span className="live-dot" />
        <div>
          <small>CLUSTER</small>
          <b>UPES-HPC</b>
        </div>
        <Icon name="chevron" size={14} />
      </div>
      <nav className="main-nav" aria-label="Primary navigation">
        {navItems.map((item) => (
          <button
            key={item.id}
            className={screen === item.id ? "active" : ""}
            onClick={() => onChange(item.id)}
          >
            <Icon name={item.icon} size={18} /> <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        <div className="capacity-label">
          <span>CLUSTER CAPACITY</span>
          <b>88.5%</b>
        </div>
        <div className="progress">
          <i style={{ width: "88.5%" }} />
        </div>
        <p>184 / 208 cores allocated</p>
        <div className="operator">
          <div className="avatar">A2</div>
          <div>
            <b>arun.26025</b>
            <small>Student</small>
          </div>
          <Icon name="more" size={18} />
        </div>
      </div>
    </aside>
  );
}

function KpiCard({
  title,
  value,
  suffix,
  change,
  visual,
}: {
  title: string;
  value: string;
  suffix?: string;
  change: string;
  visual?: "split" | "bars";
}) {
  return (
    <Card className="kpi-card">
      <span className="eyebrow">{title}</span>
      <div className="kpi-main">
        <strong>{value}</strong>
        {suffix && <span>{suffix}</span>}
      </div>
      <div className="kpi-bottom">
        {visual === "split" ? (
          <div className="mini-progress">
            <i style={{ width: "74%" }} />
          </div>
        ) : visual === "bars" ? (
          <div className="mini-bars">
            <i />
            <i />
            <i />
            <i />
          </div>
        ) : (
          <span className={change.includes("↑") ? "up" : ""}>{change}</span>
        )}
        {visual && <span>{change}</span>}
      </div>
    </Card>
  );
}

function ChartPanel() {
  return (
    <Card className="chart-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">SYSTEM UTILIZATION</span>
          <h2>Live resource usage</h2>
        </div>
        <div className="chart-actions">
          <div className="legend">
            <span>
              <i className="cpu-line" /> CPU 88.5%
            </span>
            <span>
              <i className="ram-line" /> RAM 72.1%
            </span>
          </div>
          <span className="live-label">
            <i /> LIVE
          </span>
          <button className="range-btn">
            5 MIN <Icon name="chevron" size={14} />
          </button>
        </div>
      </div>
      <div className="chart-wrap">
        <div className="y-axis">
          <span>100</span>
          <span>75</span>
          <span>50</span>
          <span>25</span>
          <span>0</span>
        </div>
        <svg
          className="chart"
          viewBox="0 0 792 140"
          preserveAspectRatio="none"
          role="img"
          aria-label="CPU and RAM utilization over last five minutes"
        >
          <path className="grid-line" d="M0 10H792M0 43H792M0 76H792M0 109H792M0 138H792" />
          <path className="ram-path" d={linePaths.ram} />
          <path className="cpu-path" d={linePaths.cpu} />
          <circle className="current-dot" cx="774" cy="17" r="3.5" />
        </svg>
        <div className="x-axis">
          <span>-5:00</span>
          <span>-4:00</span>
          <span>-3:00</span>
          <span>-2:00</span>
          <span>-1:00</span>
          <span>NOW</span>
        </div>
      </div>
      <div className="chart-footer">
        <span>
          <b>+3.1%</b> CPU vs. 5 min ago
        </span>
        <span>Data refreshes every second</span>
      </div>
    </Card>
  );
}

function GpuFabric() {
  return (
    <Card className="gpu-fabric-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">COMPUTE FABRIC</span>
          <h2>
            GPU fabric <span className="muted-count">/ 16 × NVIDIA H100 80GB HBM3 (Hopper)</span>
          </h2>
        </div>
        <button className="text-button">
          View nodes <Icon name="arrow" size={15} />
        </button>
      </div>
      <div className="gpu-node-cards">
        {gpuNodes.map((node) => (
          <div className="gpu-node-card" key={node.name}>
            <div className="gpu-node-title">
              <span className="node-square" />
              <b>{node.name}</b>
              <StatusPill tone={node.state}>{node.state}</StatusPill>
            </div>
            <div>
              <span>CORES</span>
              <b>{node.cores}</b>
            </div>
            <div>
              <span>RAM</span>
              <b>{node.ram}</b>
            </div>
            <div>
              <span>LOAD AVG.</span>
              <b>{node.load}</b>
            </div>
          </div>
        ))}
      </div>
      <div className="gpu-rows">
        {gpuNodes.map((node) => (
          <div className="gpu-row-group" key={node.name}>
            <div className="gpu-row-label">{node.name}</div>
            <div className="gpu-tile-grid">
              {node.gpus.map(([utilisation, memory, temperature], index) => (
                <button
                  className={`gpu-tile ${utilisation > 90 ? "gpu-hot" : utilisation > 75 ? "gpu-high" : utilisation > 30 ? "gpu-mid" : "gpu-low"}`}
                  key={`${node.name}-${index}`}
                  aria-label={`${node.name} GPU ${index}, ${utilisation}% utilisation, ${memory}, ${temperature}`}
                >
                  <span>GPU {index}</span>
                  <strong>{utilisation}%</strong>
                  <small>{memory}</small>
                  <em>{temperature}</em>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="gpu-fabric-footer">
        <span>Utilisation is node-wide and includes all users.</span>
        <span>
          14 allocated <i className="dot-separator" /> 2 free
        </span>
      </div>
    </Card>
  );
}

function ActivityFeed() {
  const events: [string, string, StatusTone, string][] = [
    ["14:32:09", "JOB STARTED", "online", "741829 · vllm_serve"],
    ["14:31:40", "GPU FREED", "online", "gpu01 · GPU 7 returned to pool"],
    ["14:30:18", "JOB COMPLETED", "online", "741794 · result staging begun"],
    ["14:29:56", "RESOURCE ALERT", "warning", "gpu02 · GPU 0 temperature: 80°C"],
    ["14:28:22", "JOB QUEUED", "neutral", "741830 · brain_stroke_train (workq)"],
  ];
  return (
    <Card className="activity-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">EVENT STREAM</span>
          <h2>Activity</h2>
        </div>
        <button className="icon-button" aria-label="Activity options">
          <Icon name="more" />
        </button>
      </div>
      <div className="feed-list">
        {events.map(([time, title, tone, detail]) => (
          <div className="event" key={`${time}-${title}`}>
            <div className="event-time">{time}</div>
            <div className={`event-marker ${tone}`}>
              <i />
            </div>
            <div>
              <StatusPill tone={tone}>{title}</StatusPill>
              <p>{detail}</p>
            </div>
          </div>
        ))}
      </div>
      <button className="feed-button">
        All activity <Icon name="arrow" size={15} />
      </button>
    </Card>
  );
}

function OverviewScreen() {
  return (
    <div className="screen overview-screen">
      <div className="kpi-grid">
        <KpiCard title="GPUS FREE" value="2" suffix="/ 16" change="14 allocated" />
        <KpiCard title="JOBS RUNNING" value="6" change="2 on GPU queue" />
        <KpiCard title="JOBS QUEUED" value="3" change="Estimated start < 14m" />
        <KpiCard title="CPU CORES ALLOCATED" value="184" suffix=" / 208" change="88.5% allocated" />
        <KpiCard
          title="RAM ALLOCATED"
          value="1.44"
          suffix=" / 2 TB"
          change="72% allocated"
          visual="split"
        />
        <KpiCard
          title="HOME QUOTA USED"
          value="61"
          suffix=" G / 400 G"
          change="15.3% used"
          visual="bars"
        />
      </div>
      <div className="dashboard-grid">
        <ChartPanel />
        <ActivityFeed />
        <GpuFabric />
      </div>
    </div>
  );
}

function SortArrow({ active = false }: { active?: boolean }) {
  return <span className={active ? "sort-arrow active" : "sort-arrow"}>↕</span>;
}

function NodesScreen() {
  const [drawerNode, setDrawerNode] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState("Node name");
  const visibleNodes = useMemo(
    () =>
      [...nodes].sort((a, b) =>
        sortBy === "Load avg." ? Number(b[5]) - Number(a[5]) : a[0].localeCompare(b[0]),
      ),
    [sortBy],
  );
  return (
    <div className="screen table-screen">
      <div className="screen-toolbar">
        <div>
          <span className="eyebrow">COMPUTE FABRIC</span>
          <h2>
            Nodes <span className="muted-count">2 total</span>
          </h2>
        </div>
        <div className="toolbar-actions">
          <button className="secondary-button">
            <Icon name="filter" size={16} /> All states <Icon name="chevron" size={14} />
          </button>
          <label className="search-box">
            <Icon name="search" size={16} />
            <input placeholder="Find node..." />
          </label>
        </div>
      </div>
      <Card className="data-card">
        <div className="table-meta">
          <span>
            Showing <b>2</b> of 2 nodes
          </span>
          <span>
            Last polled <b>just now</b>
          </span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {[
                  "Node name",
                  "State",
                  "Cores used",
                  "RAM used",
                  "GPUs allocated",
                  "Load avg.",
                  "Uptime",
                ].map((head) => (
                  <th key={head}>
                    <button onClick={() => setSortBy(head)}>
                      {head}
                      <SortArrow active={sortBy === head} />
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleNodes.map((node) => (
                <tr key={node[0]} onClick={() => setDrawerNode(node[0])} tabIndex={0}>
                  <td className="node-name">
                    <span className="node-square" />
                    {node[0]}
                  </td>
                  <td>
                    <StatusPill tone={node[1] as StatusTone}>{node[1]}</StatusPill>
                  </td>
                  <td>{node[2]}</td>
                  <td>{node[3]}</td>
                  <td>{node[4]}</td>
                  <td className={node[1] === "warning" ? "amber-text" : ""}>{node[5]}</td>
                  <td>{node[6]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {drawerNode && <NodeDrawer node={drawerNode} onClose={() => setDrawerNode(null)} />}
    </div>
  );
}

function NodeDrawer({ node, onClose }: { node: string; onClose: () => void }) {
  const nodeData = gpuNodes.find((item) => item.name === node) ?? gpuNodes[0];
  return (
    <>
      <button className="drawer-backdrop" onClick={onClose} aria-label="Close node details" />
      <aside className="drawer">
        <div className="drawer-header">
          <div>
            <span className="eyebrow">NODE DETAIL</span>
            <h2>{node}</h2>
          </div>
          <button className="icon-button" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="drawer-status">
          <StatusPill tone="online">ONLINE</StatusPill>
          <span>Last heartbeat: 0.8s ago</span>
        </div>
        <div className="detail-metrics">
          <div>
            <small>CPU</small>
            <b>
              {nodeData.cores.split(" / ")[0]} <em>/ 104 cores</em>
            </b>
            <div className="progress">
              <i style={{ width: node === "gpu01" ? "92.3%" : "84.6%" }} />
            </div>
          </div>
          <div>
            <small>MEMORY</small>
            <b>
              {nodeData.ram.split(" / ")[0]} <em>/ 1,024 GB</em>
            </b>
            <div className="progress">
              <i style={{ width: node === "gpu01" ? "72%" : "68.8%" }} />
            </div>
          </div>
        </div>
        <div className="gpu-block">
          <div className="section-label">
            <span>GPU UTILIZATION</span>
            <b>{node === "gpu01" ? "6 / 8" : "8 / 8"} allocated</b>
          </div>
          {nodeData.gpus.map(([load], index) => (
            <div className="gpu-row" key={index}>
              <span>GPU {index}</span>
              <div className="gpu-bar">
                <i style={{ width: `${load}%` }} />
              </div>
              <b>{load}%</b>
              <small>H100 80GB HBM3</small>
            </div>
          ))}
        </div>
        <div className="drawer-info">
          <div>
            <small>IP ADDRESS</small>
            <b>{node === "gpu01" ? "10.24.3.101" : "10.24.3.102"}</b>
          </div>
          <div>
            <small>UPTIME</small>
            <b>18d 04h 12m</b>
          </div>
          <div>
            <small>CURRENT JOBS</small>
            <b>{node === "gpu01" ? "2 running" : "4 running"}</b>
          </div>
        </div>
      </aside>
    </>
  );
}

function JobsScreen() {
  const [tab, setTab] = useState<"running" | "queued" | "finished">("running");
  const tabJobs =
    tab === "running"
      ? jobs.filter((job) => job[4] === "running")
      : tab === "queued"
        ? jobs.filter((job) => job[4] === "queued")
        : [];
  return (
    <div className="screen table-screen">
      <div className="screen-toolbar">
        <div>
          <span className="eyebrow">WORKLOAD MANAGER</span>
          <h2>
            Jobs <span className="muted-count">9 active</span>
          </h2>
        </div>
        <button className="primary-button">
          Submit job <Icon name="arrow" size={15} />
        </button>
      </div>
      <div className="tabs" role="tablist">
        {(["running", "queued", "finished"] as const).map((item) => (
          <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>
            {item} <span>{item === "running" ? 6 : item === "queued" ? 3 : "1.2k"}</span>
          </button>
        ))}
      </div>
      <Card className="data-card">
        <div className="filter-row">
          <label className="search-box">
            <Icon name="search" size={16} />
            <input placeholder="Search job ID, name, or user..." />
          </label>
          <button className="secondary-button">
            <Icon name="filter" size={16} /> Filter <span className="filter-count">2</span>
          </button>
          <button className="secondary-button">
            Queue: All <Icon name="chevron" size={14} />
          </button>
        </div>
        <div className="table-scroll jobs-table">
          <table>
            <thead>
              <tr>
                {[
                  "Job ID",
                  "Name",
                  "User",
                  "Queue",
                  "State",
                  "CPUs",
                  "GPUs",
                  "Memory",
                  "Walltime used / limit",
                  "Elapsed",
                ].map((head) => (
                  <th key={head}>
                    <button>
                      {head}
                      <SortArrow />
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tabJobs.length ? (
                tabJobs.map((job) => (
                  <tr key={job[0]}>
                    <td className="blue-text">{job[0]}</td>
                    <td className="job-name">{job[1]}</td>
                    <td>{job[2]}</td>
                    <td>{job[3]}</td>
                    <td>
                      <StatusPill tone={job[4] === "running" ? "online" : "neutral"}>
                        {job[4]}
                      </StatusPill>
                    </td>
                    <td>{job[5]}</td>
                    <td>{job[6]}</td>
                    <td>{job[7]}</td>
                    <td>{job[8]}</td>
                    <td>{job[9]}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="empty-cell" colSpan={10}>
                    No finished jobs in this filtered view.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function LogsScreen() {
  const [selected, setSelected] = useState(3);
  const [search, setSearch] = useState("");
  const filtered = logLines.filter(
    (line) => line.text.toLowerCase().includes(search.toLowerCase()) || line.node.includes(search),
  );
  const active = logLines[selected];
  return (
    <div className="screen logs-screen">
      <div className="screen-toolbar">
        <div>
          <span className="eyebrow">SYSTEM JOURNAL</span>
          <h2>
            Logs <span className="muted-count">Last 24 hours</span>
          </h2>
        </div>
        <button className="secondary-button">
          <Icon name="clock" size={16} /> Today <Icon name="chevron" size={14} />
        </button>
      </div>
      <div className="logs-layout">
        <Card className="log-filters">
          <div className="filter-title">
            <span>FILTERS</span>
            <button>Reset</button>
          </div>
          <FilterGroup
            title="Level"
            options={["Info", "Warning", "Error", "Debug"]}
            checked={["Info", "Warning", "Error"]}
          />
          <FilterGroup
            title="Node"
            options={["mgmt01", "gpu01", "gpu02"]}
            checked={["All nodes"]}
          />
          <FilterGroup
            title="Source"
            options={["All sources", "slurmd", "node-watch", "scheduler"]}
            checked={["All sources"]}
          />
        </Card>
        <Card className="log-stream">
          <div className="log-stream-header">
            <label className="search-box">
              <Icon name="search" size={16} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search log stream..."
              />
            </label>
            <button className="icon-button">
              <Icon name="more" />
            </button>
          </div>
          <div className="stream-meta">
            <span>
              <span className="live-dot" /> TAILING <b>382 lines</b>
            </span>
            <span>UTC</span>
          </div>
          <div className="log-list">
            {filtered.map((line) => {
              const realIndex = logLines.indexOf(line);
              return (
                <button
                  className={`log-row ${selected === realIndex ? "selected" : ""}`}
                  key={`${line.time}-${line.text}`}
                  onClick={() => setSelected(realIndex)}
                >
                  <time>{line.time}</time>
                  <StatusPill
                    tone={
                      line.level === "ERROR"
                        ? "critical"
                        : line.level === "WARN"
                          ? "warning"
                          : line.level === "DEBUG"
                            ? "neutral"
                            : "online"
                    }
                  >
                    {line.level}
                  </StatusPill>
                  <b>{line.node}</b>
                  <code>{line.text}</code>
                </button>
              );
            })}
          </div>
        </Card>
        <Card className="log-detail">
          <div className="detail-heading">
            <span>SELECTED EVENT</span>
            <StatusPill
              tone={
                active.level === "ERROR"
                  ? "critical"
                  : active.level === "WARN"
                    ? "warning"
                    : "online"
              }
            >
              {active.level}
            </StatusPill>
          </div>
          <div className="detail-message">{active.text}</div>
          <dl>
            <div>
              <dt>TIMESTAMP</dt>
              <dd>2025-08-24 {active.time} UTC</dd>
            </div>
            <div>
              <dt>NODE</dt>
              <dd className="blue-text">{active.node}</dd>
            </div>
            <div>
              <dt>SOURCE</dt>
              <dd>{active.source}</dd>
            </div>
            <div>
              <dt>EVENT ID</dt>
              <dd>evt_08f2b6c8e</dd>
            </div>
          </dl>
          <div className="raw-block">
            <span>RAW MESSAGE</span>
            <code>
              systemd[1]: {active.source}: {active.text}
            </code>
          </div>
          <button className="secondary-button wide-button">
            <Icon name="terminal" size={16} /> Open related logs
          </button>
        </Card>
      </div>
    </div>
  );
}

function FilterGroup({
  title,
  options,
  checked,
}: {
  title: string;
  options: string[];
  checked: string[];
}) {
  return (
    <div className="filter-group">
      <b>{title}</b>
      {options.map((option) => (
        <label key={option}>
          <input type="checkbox" defaultChecked={checked.includes(option)} />
          <span>{option}</span>
        </label>
      ))}
    </div>
  );
}

function SettingsScreen() {
  const [refresh, setRefresh] = useState("1 second");
  const [replay, setReplay] = useState(false);
  return (
    <div className="screen settings-screen">
      <div className="screen-toolbar">
        <div>
          <span className="eyebrow">CONTROL ROOM</span>
          <h2>Settings</h2>
        </div>
      </div>
      <div className="settings-grid">
        <Card className="settings-card">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">DATA STREAM</span>
              <h2>Connection</h2>
            </div>
            <StatusPill tone="online">CONNECTED</StatusPill>
          </div>
          <div className="connection-stat">
            <span className="live-dot" />
            <div>
              <b>Node API (laptop) → collector</b>
              <small>ws://localhost:3000/stream</small>
            </div>
            <button className="secondary-button">Reconnect</button>
          </div>
          <div className="settings-row">
            <div>
              <b>Data source</b>
              <small>PBS (qstat + pbsnodes) + node sampler</small>
            </div>
            <span className="clock-skew">live</span>
          </div>
          <div className="settings-row">
            <div>
              <b>Refresh interval</b>
              <small>How often live metrics poll the cluster</small>
            </div>
            <select value={refresh} onChange={(e) => setRefresh(e.target.value)}>
              <option>1 second</option>
              <option>5 seconds</option>
              <option>15 seconds</option>
              <option>30 seconds</option>
            </select>
          </div>
          <div className="settings-row">
            <div>
              <b>Clock skew</b>
              <small>gpu01/gpu02 vs mgmt01 (NTP drift)</small>
            </div>
            <span className="clock-skew">+12m 03s</span>
          </div>
        </Card>
        <Card className="settings-card">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">PLAYBACK</span>
              <h2>Replay mode</h2>
            </div>
          </div>
          <div className="settings-row">
            <div>
              <b>Use recorded data</b>
              <small>Play back an incident recording instead of live cluster events</small>
            </div>
            <button
              className={`toggle ${replay ? "on" : ""}`}
              onClick={() => setReplay(!replay)}
              aria-pressed={replay}
            >
              <i />
            </button>
          </div>
          {replay && (
            <div className="replay-active">
              <Icon name="clock" size={16} /> Replay loaded: <b>Aug 22 · 14:00–15:30 UTC</b>
            </div>
          )}
        </Card>
        <Card className="settings-card">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">INTERFACE</span>
              <h2>Appearance</h2>
            </div>
          </div>
          <div className="settings-row">
            <div>
              <b>Theme</b>
              <small>Selected theme applies across this console</small>
            </div>
            <div className="theme-choice">
              <button className="active">Dark</button>
              <button>System</button>
            </div>
          </div>
          <div className="settings-row">
            <div>
              <b>Compact tables</b>
              <small>Reduce vertical density in data tables</small>
            </div>
            <button className="toggle on">
              <i />
            </button>
          </div>
        </Card>
      </div>
    </div>
  );
}

function App() {
  const [screen, setScreen] = useState<Screen>("overview");
  return (
    <div className="app-shell">
      <Sidebar screen={screen} onChange={setScreen} />
      <main className="main-area">
        <Header screen={screen} />
        {screen === "overview" && <OverviewScreen />}
        {screen === "nodes" && <NodesScreen />}
        {screen === "jobs" && <JobsScreen />}
        {screen === "logs" && <LogsScreen />}
        {screen === "settings" && <SettingsScreen />}
      </main>
    </div>
  );
}

export default App;
