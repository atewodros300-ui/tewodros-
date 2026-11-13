import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  Activity, ArrowDownRight, ArrowUpRight, Bell, Building2, Check, CheckCheck,
  ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3, Download, Ellipsis,
  FileClock, Filter, Headphones, LayoutDashboard, MapPin, Plus, Search, Settings2,
  ShieldCheck, Sparkles, TicketCheck, Users, X,
} from "lucide-react";
import { api } from "./api";
import { SERVICE_CATEGORIES, type AppState, type Branch, type Visitor } from "./types";

type View = "overview" | "queue" | "branches" | "visitors" | "settings";
type OpenPopover = "workspace" | "notifications" | "profile" | "sidebar-profile" | null;

const navigation: { id: View; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "overview", label: "HQ overview", icon: LayoutDashboard },
  { id: "queue", label: "Live queue", icon: TicketCheck },
  { id: "branches", label: "Branch directory", icon: Building2 },
  { id: "visitors", label: "Visitor records", icon: FileClock },
];

const demoHourly = [
  { time: "08:00", arrivals: 12, served: 8 },
  { time: "09:00", arrivals: 21, served: 15 },
  { time: "10:00", arrivals: 29, served: 22 },
  { time: "11:00", arrivals: 26, served: 21 },
  { time: "12:00", arrivals: 19, served: 16 },
  { time: "13:00", arrivals: 23, served: 19 },
  { time: "14:00", arrivals: 31, served: 25 },
  { time: "15:00", arrivals: 25, served: 22 },
  { time: "16:00", arrivals: 18, served: 16 },
  { time: "17:00", arrivals: 10, served: 9 },
];

const heatmapHours = ["08", "10", "12", "14", "16"];
const heatmap = [
  [2, 4, 3, 5, 2],
  [1, 3, 2, 4, 2],
  [2, 3, 4, 3, 1],
  [1, 2, 2, 3, 2],
  [1, 2, 3, 2, 1],
];

function isToday(value: string) {
  return new Date(value).toDateString() === new Date().toDateString();
}

function clockTime(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function durationLabel(seconds: number | null) {
  if (seconds === null) return "—";
  const minutes = Math.max(0, Math.round(seconds / 60));
  return `${minutes} min`;
}

function displayDate() {
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date());
}

function branchFor(branches: Branch[], id: string) {
  return branches.find((branch) => branch.id === id);
}

function visitStats(visitors: Visitor[]) {
  const today = visitors.filter((visitor) => isToday(visitor.createdAt));
  const served = today.filter((visitor) => visitor.status === "SERVED").length;
  const walkaways = today.filter((visitor) => visitor.status === "WALK_AWAY").length;
  const resolved = served + walkaways;
  const waitSamples = today.filter((visitor) => visitor.waitSeconds !== null);
  const averageWait = waitSamples.length
    ? Math.round(waitSamples.reduce((sum, visitor) => sum + (visitor.waitSeconds ?? 0), 0) / waitSamples.length / 60)
    : 0;
  return {
    checkedIn: today.length,
    waiting: today.filter((visitor) => visitor.status === "WAITING").length,
    called: today.filter((visitor) => visitor.status === "CALLED").length,
    served,
    walkaways,
    walkawayRate: resolved ? Math.round((walkaways / resolved) * 100) : 0,
    averageWait,
  };
}

function App() {
  const [data, setData] = useState<AppState>({ branches: [], visitors: [] });
  const [view, setView] = useState<View>("overview");
  const [selectedBranch, setSelectedBranch] = useState("all");
  const [serviceFilter, setServiceFilter] = useState("All services");
  const [search, setSearch] = useState("");
  const [ticketModal, setTicketModal] = useState(false);
  const [branchModal, setBranchModal] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [openPopover, setOpenPopover] = useState<OpenPopover>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [refreshTime, setRefreshTime] = useState(new Date());

  const refreshState = useCallback(async () => {
    try {
      const state = await api.state();
      setData(state);
      setError("");
      setRefreshTime(new Date());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not connect to the local API.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshState();
    if (!autoRefresh) return;
    const timer = window.setInterval(() => void refreshState(), 15_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, refreshState]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!openPopover) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest(".popover-anchor, .sidebar-menu-anchor, .sidebar-profile-anchor")) {
        setOpenPopover(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenPopover(null);
    };
    window.addEventListener("pointerdown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [openPopover]);

  const visibleBranches = useMemo(
    () => selectedBranch === "all" ? data.branches : data.branches.filter((branch) => branch.id === selectedBranch),
    [data.branches, selectedBranch],
  );
  const selectedVisitors = useMemo(
    () => data.visitors.filter((visitor) => selectedBranch === "all" || visitor.branchId === selectedBranch),
    [data.visitors, selectedBranch],
  );
  const visibleVisitors = useMemo(() => {
    const text = search.trim().toLowerCase();
    return selectedVisitors
      .filter((visitor) => serviceFilter === "All services" || visitor.serviceCategory === serviceFilter)
      .filter((visitor) => !text || `${visitor.ticket} ${visitor.serviceCategory}`.toLowerCase().includes(text))
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }, [search, selectedVisitors, serviceFilter]);
  const stats = useMemo(() => visitStats(selectedVisitors), [selectedVisitors]);
  const branchMetrics = useMemo(() => visibleBranches.map((branch) => {
    const branchVisitors = data.visitors.filter((visitor) => visitor.branchId === branch.id && isToday(visitor.createdAt));
    const branchStats = visitStats(branchVisitors);
    return { branch, visitors: branchVisitors, stats: branchStats };
  }), [data.visitors, visibleBranches]);
  const notifications = [
    ...(error ? [{ title: "API connection issue", detail: error, type: "error" as const }] : []),
    ...(stats.walkawayRate > 10
      ? [{ title: "Walk-away rate above target", detail: `${stats.walkawayRate}% across the selected branches today.`, type: "warning" as const }]
      : []),
  ];
  const pageTitle = view === "settings" ? "System settings" : navigation.find((item) => item.id === view)?.label;

  const performAction = async (visitor: Visitor, action: "call" | "serve" | "walkaway") => {
    try {
      await api.updateVisitor(visitor.id, action);
      await refreshState();
      setToast(action === "call" ? `${visitor.ticket} called to counter` : action === "serve" ? `${visitor.ticket} marked as served` : `${visitor.ticket} marked as walk-away`);
    } catch (reason) {
      setToast(reason instanceof Error ? reason.message : "Action could not be completed.");
    }
  };

  const createTicket = async (branchId: string, category: string) => {
    try {
      const result = await api.createVisitor(branchId, category);
      await refreshState();
      setTicketModal(false);
      setToast(`Ticket ${result.visitor.ticket} issued`);
      setView("queue");
    } catch (reason) {
      setToast(reason instanceof Error ? reason.message : "Could not issue ticket.");
    }
  };

  const exportCsv = () => {
    const rows = visibleVisitors.map((visitor) => [
      visitor.ticket,
      branchFor(data.branches, visitor.branchId)?.name ?? visitor.branchId,
      visitor.serviceCategory,
      visitor.status,
      visitor.createdAt,
      visitor.waitSeconds ?? "",
    ]);
    const csv = [
      ["Ticket", "Branch", "Service", "Status", "Checked in (UTC)", "Wait seconds"].join(","),
      ...rows.map((row) => row.map((field) => `"${String(field).replaceAll('"', '""')}"`).join(",")),
    ].join("\r\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    link.download = `govflow-visitors-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const updateStaff = async (branch: Branch, change: number) => {
    const staffCount = Math.max(1, branch.staffCount + change);
    try {
      await api.updateBranch(branch, { staffCount });
      await refreshState();
      setToast(`${branch.name} staffing updated`);
    } catch (reason) {
      setToast(reason instanceof Error ? reason.message : "Could not update staffing.");
    }
  };

  const updateTarget = async (branch: Branch, targetWaitMinutes: number) => {
    try {
      await api.updateBranch(branch, { targetWaitMinutes });
      await refreshState();
      setToast(`${branch.name} wait-time target updated`);
    } catch (reason) {
      setToast(reason instanceof Error ? reason.message : "Could not update target.");
    }
  };

  if (loading) {
    return <div className="loading-screen"><div className="loader" /><span>Connecting to HQ operations…</span></div>;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><ShieldCheck size={21} strokeWidth={2.2} /></div>
          <div><strong>govflow</strong><span>PUBLIC SERVICE OPS</span></div>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <div className="sidebar-menu-anchor">
          <button className="workspace-switch" aria-expanded={openPopover === "workspace"} onClick={() => setOpenPopover(openPopover === "workspace" ? null : "workspace")}>
            <span className="workspace-icon"><Building2 size={17} /></span>
            <span className="workspace-copy"><b>Head Office</b><span>National operations</span></span>
            <ChevronDown size={16} className="muted" />
          </button>
          {openPopover === "workspace" && (
            <div className="workspace-popover" role="dialog" aria-label="Workspace details">
              <span className="popover-eyebrow">ACTIVE WORKSPACE</span>
              <strong>Head Office</strong>
              <p>National operations across all service branches.</p>
              <button onClick={() => { setView("branches"); setOpenPopover(null); }}>Manage service locations <ChevronRight size={14} /></button>
            </div>
          )}
        </div>
        <div className="nav-label">OPERATIONS</div>
        <nav className="primary-nav" aria-label="Main navigation">
          {navigation.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`nav-item ${view === id ? "active" : ""}`} onClick={() => { setView(id); setOpenPopover(null); }}>
              <Icon size={18} strokeWidth={1.9} /><span>{label}</span>
              {id === "queue" && stats.waiting > 0 && <span className="nav-count">{stats.waiting}</span>}
            </button>
          ))}
        </nav>
        <div className="nav-label manage-label">MANAGE</div>
        <button className={`nav-item ${view === "settings" ? "active" : ""}`} aria-current={view === "settings" ? "page" : undefined} onClick={() => { setView("settings"); setOpenPopover(null); }}>
          <Settings2 size={18} strokeWidth={1.9} /><span>System settings</span>
        </button>
        <div className="sidebar-spacer" />
        <div className="sidebar-help">
          <div className="help-icon"><Headphones size={17} /></div>
          <strong>Need a hand?</strong>
          <p>Visit the operations guide for help with daily workflows.</p>
          <button onClick={() => setHelpOpen(true)}>Open help center <ChevronRight size={14} /></button>
        </div>
        <div className="sidebar-profile-anchor">
          <button className="profile" aria-label="Open HQ Administrator account menu" aria-expanded={openPopover === "sidebar-profile"} onClick={() => setOpenPopover(openPopover === "sidebar-profile" ? null : "sidebar-profile")}>
            <span className="profile-avatar">HQ</span>
            <span className="profile-copy"><b>HQ Administrator</b><span>Central office</span></span>
            <Ellipsis size={19} className="muted" />
          </button>
          {openPopover === "sidebar-profile" && (
            <ProfilePopover
              placement="sidebar"
              onSettings={() => { setView("settings"); setOpenPopover(null); }}
            />
          )}
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="crumb"><span>Government Services</span><ChevronRight size={14} /><b>{pageTitle}</b></div>
          <div className="topbar-actions">
            <span className={`system-pill ${error ? "system-offline" : ""}`}><i /> {error ? "API connection issue" : "Demo systems operational"}</span>
            <div className="popover-anchor">
              <button className="icon-button notification-button" aria-label="Notifications" aria-expanded={openPopover === "notifications"} aria-controls="notifications-panel" onClick={() => setOpenPopover(openPopover === "notifications" ? null : "notifications")}>
                <Bell size={18} />{notifications.length > 0 && <i className="notification-dot" />}
              </button>
              {openPopover === "notifications" && (
                <div className="topbar-popover notifications-popover" id="notifications-panel" role="dialog" aria-label="Notifications">
                  <div className="popover-heading"><strong>Notifications</strong><span>{notifications.length ? `${notifications.length} active` : "All clear"}</span></div>
                  {notifications.length === 0 ? (
                    <div className="empty-notifications"><CheckCheck size={18} /><div><strong>You're all caught up.</strong><span>No active alerts from the current demo data.</span></div></div>
                  ) : notifications.map((notification) => (
                    <div className={`notification-item ${notification.type}`} key={notification.title}>
                      <CircleHelp size={17} />
                      <div><strong>{notification.title}</strong><span>{notification.detail}</span></div>
                    </div>
                  ))}
                  {stats.walkawayRate > 10 && <button className="popover-action" onClick={() => { setView("branches"); setOpenPopover(null); }}>Review branches <ChevronRight size={14} /></button>}
                </div>
              )}
            </div>
            <div className="topbar-divider" />
            <div className="popover-anchor">
              <button className="top-profile" aria-label="HQ Administrator account" aria-expanded={openPopover === "profile"} onClick={() => setOpenPopover(openPopover === "profile" ? null : "profile")}>
                <span className="top-avatar">HQ</span><ChevronDown size={15} className="muted" />
              </button>
              {openPopover === "profile" && <ProfilePopover onSettings={() => { setView("settings"); setOpenPopover(null); }} />}
            </div>
          </div>
        </header>

        <div className="page-content">
          {error && <div className="error-banner"><CircleHelp size={17} /><span>{error} Start the API with <code>npm run dev</code>.</span><button onClick={() => void refreshState()}><Activity size={15} /> Retry</button></div>}
          <div className="page-heading">
            <div>
              <div className="eyebrow"><span className="eyebrow-dot" /> CENTRAL OPERATIONS <span className="eyebrow-separator">/</span> {displayDate().toUpperCase()}</div>
              <h1>{view === "overview" ? "Good morning, HQ team" : pageTitle}</h1>
              <p>{view === "overview" ? "Here’s what’s happening across your service network today." : view === "queue" ? "Manage tickets and keep service moving across every branch." : view === "branches" ? "Monitor branch activity, staffing, and service targets." : view === "settings" ? "Review this demo workspace and configure dashboard updates." : "A privacy-conscious view of today's issued service tickets."}</p>
            </div>
            {view !== "settings" && <div className="heading-actions">
              <label className="branch-select-label" htmlFor="branch-select"><MapPin size={16} />
                <select id="branch-select" value={selectedBranch} onChange={(event) => setSelectedBranch(event.target.value)}>
                  <option value="all">All branches</option>
                  {data.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                </select>
                <ChevronDown size={15} />
              </label>
              <button className="button button-primary" onClick={() => setTicketModal(true)}><Plus size={17} /> New visitor</button>
            </div>}
          </div>

          {view !== "settings" && <div className="snapshot-strip">
            <span className="snapshot-icon"><Activity size={15} /></span>
            <span>Live operations snapshot</span>
            <span className="snapshot-separator">·</span>
            <span>Last updated {refreshTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            <span className="live-dot" />
            <span className="snapshot-live">LIVE</span>
            <button onClick={() => void refreshState()} aria-label="Refresh dashboard"><Activity size={14} /> Refresh</button>
          </div>}

          {view !== "settings" && stats.walkawayRate > 10 && (
            <div className="alert-banner">
              <span className="alert-symbol">!</span>
              <div><b>Walk-away rate is above target</b><span>{stats.walkawayRate}% across the selected branches today. Review wait times and staffing.</span></div>
              <button onClick={() => setView("branches")}>Review branches <ChevronRight size={15} /></button>
            </div>
          )}

          {view === "overview" && (
            <Overview
              stats={stats}
              branchMetrics={branchMetrics}
              visitors={selectedVisitors}
              branches={data.branches}
              onViewQueue={() => setView("queue")}
              onSelectBranch={setSelectedBranch}
              onTicket={() => setTicketModal(true)}
            />
          )}
          {view === "queue" && (
            <QueueView
              visitors={visibleVisitors}
              branches={data.branches}
              serviceFilter={serviceFilter}
              setServiceFilter={setServiceFilter}
              search={search}
              setSearch={setSearch}
              onAction={performAction}
              onTicket={() => setTicketModal(true)}
            />
          )}
          {view === "branches" && (
            <BranchesView
              metrics={branchMetrics}
              onStaff={updateStaff}
              onTarget={updateTarget}
              onAdd={() => setBranchModal(true)}
              onSelect={(id) => { setSelectedBranch(id); setView("queue"); }}
            />
          )}
          {view === "visitors" && (
            <VisitorView
              visitors={visibleVisitors}
              branches={data.branches}
              search={search}
              setSearch={setSearch}
              serviceFilter={serviceFilter}
              setServiceFilter={setServiceFilter}
              onExport={exportCsv}
            />
          )}
          {view === "settings" && (
            <SettingsView
              apiOnline={!error}
              autoRefresh={autoRefresh}
              onAutoRefreshChange={setAutoRefresh}
              onRefresh={() => void refreshState()}
            />
          )}
          <footer className="page-footer"><span>GovFlow <b>·</b> National service operations</span><span>DEMO ENVIRONMENT <i /></span></footer>
        </div>
      </main>

      {ticketModal && <TicketModal branches={data.branches} defaultBranch={selectedBranch} onClose={() => setTicketModal(false)} onSubmit={createTicket} />}
      {branchModal && <BranchModal onClose={() => setBranchModal(false)} onSubmit={async (input) => {
        try {
          const result = await api.createBranch(input);
          await refreshState();
          setBranchModal(false);
          setToast(`${result.branch.name} added to the directory`);
        } catch (reason) {
          setToast(reason instanceof Error ? reason.message : "Could not add branch.");
        }
      }} />}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
      {toast && <div className="toast"><span className="toast-check"><Check size={15} /></span>{toast}<button onClick={() => setToast("")} aria-label="Dismiss"><X size={15} /></button></div>}
    </div>
  );
}

function ProfilePopover({ onSettings, placement = "topbar" }: {
  onSettings: () => void;
  placement?: "topbar" | "sidebar";
}) {
  return (
    <div className={`profile-popover ${placement === "sidebar" ? "profile-popover-sidebar" : ""}`} role="menu" aria-label="Account options">
      <div className="profile-popover-identity">
        <div className="profile-avatar">HQ</div>
        <div><strong>HQ Administrator</strong><span>Central office · Head Office</span></div>
      </div>
      <button role="menuitem" onClick={onSettings}><Settings2 size={15} /> System settings</button>
      <p>Demo account. User roles and sign-in are managed by the deployment administrator.</p>
    </div>
  );
}

function SettingsView({ apiOnline, autoRefresh, onAutoRefreshChange, onRefresh }: {
  apiOnline: boolean;
  autoRefresh: boolean;
  onAutoRefreshChange: (enabled: boolean) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="settings-grid">
      <section className="panel settings-card">
        <div className="panel-heading"><div><div className="panel-title">Workspace</div><div className="panel-subtitle">Current HQ operations workspace</div></div><Building2 size={18} className="settings-icon" /></div>
        <div className="settings-detail"><span>Name</span><strong>Head Office</strong></div>
        <div className="settings-detail"><span>Scope</span><strong>National operations</strong></div>
        <div className="settings-detail"><span>Environment</span><strong>Local demo</strong></div>
      </section>
      <section className="panel settings-card">
        <div className="panel-heading"><div><div className="panel-title">Dashboard updates</div><div className="panel-subtitle">Control how this page refreshes live data</div></div><Activity size={18} className="settings-icon" /></div>
        <div className="settings-control">
          <div><strong>Automatic refresh</strong><span>Refresh data every 15 seconds while enabled.</span></div>
          <button className={`switch ${autoRefresh ? "switch-on" : ""}`} role="switch" aria-checked={autoRefresh} aria-label="Automatic dashboard refresh" onClick={() => onAutoRefreshChange(!autoRefresh)}><span /></button>
        </div>
        <div className="settings-detail"><span>API status</span><strong className={apiOnline ? "settings-status-online" : "settings-status-offline"}>{apiOnline ? "Connected" : "Connection issue"}</strong></div>
        <div className="settings-actions"><button className="button button-outline" onClick={onRefresh}><Activity size={14} /> Refresh now</button></div>
      </section>
      <section className="panel settings-card settings-privacy">
        <div className="panel-heading"><div><div className="panel-title">Data and privacy</div><div className="panel-subtitle">Demo environment guidance</div></div><ShieldCheck size={18} className="settings-icon" /></div>
        <p>This demo stores sample visitor and queue data locally on the API server. It is not configured for real citizen records or production access controls.</p>
      </section>
    </div>
  );
}

function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Operations guide" subtitle="Quick help for the GovFlow HQ demo." onClose={onClose}>
      <div className="help-guide">
        <section><strong>Issue a visitor ticket</strong><p>Select a branch, choose <b>New visitor</b>, then pick the service category. The ticket appears in the live queue.</p></section>
        <section><strong>Manage a queue</strong><p>Open <b>Live queue</b> to call the next ticket, mark service complete, or record a walk-away.</p></section>
        <section><strong>Manage branches</strong><p>Use <b>Branch directory</b> to review locations, adjust staffing and wait targets, or add a demo branch.</p></section>
        <section><strong>Connection or settings issue?</strong><p>Check the API status in System settings. Start both local services with <code>npm run dev</code> if the API is offline.</p></section>
      </div>
      <div className="modal-actions"><button className="button button-primary" onClick={onClose}>Got it</button></div>
    </Modal>
  );
}

interface BranchMetric {
  branch: Branch;
  visitors: Visitor[];
  stats: ReturnType<typeof visitStats>;
}

function Overview({ stats, branchMetrics, visitors, branches, onViewQueue, onSelectBranch, onTicket }: {
  stats: ReturnType<typeof visitStats>;
  branchMetrics: BranchMetric[];
  visitors: Visitor[];
  branches: Branch[];
  onViewQueue: () => void;
  onSelectBranch: (id: string) => void;
  onTicket: () => void;
}) {
  const servedRate = stats.checkedIn ? Math.round((stats.served / stats.checkedIn) * 100) : 0;
  const waitingNow = visitors.filter((visitor) => visitor.status === "WAITING");
  const queuePreview = waitingNow.slice(0, 5);
  const heatBranches = branchMetrics.slice(0, 5);

  return (
    <>
      <section className="metric-grid" aria-label="Today's key metrics">
        <MetricCard label="Visitors checked in" value={stats.checkedIn.toLocaleString()} change="Across selected branches" icon={<Users size={18} />} tone="blue" foot={<><span className="metric-foot-icon"><ArrowUpRight size={14} /></span> Today's total</>} />
        <MetricCard label="Currently waiting" value={stats.waiting.toLocaleString()} change={stats.called ? `${stats.called} currently at counter` : "No active counter calls"} icon={<Clock3 size={18} />} tone="orange" foot={<><span className="metric-live"><i /></span> Live queue</>} />
        <MetricCard label="Visitors served" value={stats.served.toLocaleString()} change={`${servedRate}% of today's check-ins`} icon={<CheckCheck size={18} />} tone="green" foot={<><span className="metric-foot-icon green"><ArrowUpRight size={14} /></span> Service completed</>} />
        <MetricCard label="Average wait" value={`${stats.averageWait} min`} change="Against branch wait-time targets" icon={<Activity size={18} />} tone="violet" foot={<><span className="metric-foot-icon violet"><ArrowDownRight size={14} /></span> vs. previous hour</>} />
      </section>

      <section className="overview-grid">
        <div className="panel arrivals-panel">
          <div className="panel-heading">
            <div><div className="panel-title">Visitor flow</div><div className="panel-subtitle">Hourly arrivals and completed services</div></div>
            <span className="select-small"><span>Today</span><ChevronDown size={14} /></span>
          </div>
          <div className="chart-legend"><span><i className="legend-arrivals" /> Arrivals</span><span><i className="legend-served" /> Served</span><span className="demo-label">Illustrative demo trend</span></div>
          <div className="chart-wrap">
            <svg className="flow-chart" viewBox="0 0 760 230" role="img" aria-label="Illustrative line chart of hourly visitor arrivals and served visits">
              <defs>
                <linearGradient id="arrivalFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#2c82e0" stopOpacity=".16" /><stop offset="100%" stopColor="#2c82e0" stopOpacity="0" /></linearGradient>
              </defs>
              {[30, 75, 120, 165].map((y) => <line key={y} x1="42" x2="745" y1={y} y2={y} className="chart-gridline" />)}
              {[0, 10, 20, 30].map((v, index) => <text key={v} x="27" y={169 - index * 45} className="chart-axis" textAnchor="end">{v}</text>)}
              {(() => {
                const points = demoHourly.map((point, index) => `${48 + index * 76},${174 - point.arrivals * 4.4}`).join(" ");
                const servedPoints = demoHourly.map((point, index) => `${48 + index * 76},${174 - point.served * 4.4}`).join(" ");
                return <>
                  <polygon points={`48,174 ${points} 732,174`} fill="url(#arrivalFill)" />
                  <polyline points={points} fill="none" stroke="#347fda" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
                  <polyline points={servedPoints} fill="none" stroke="#37b38a" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" strokeDasharray="5 6" />
                  {demoHourly.map((point, index) => <circle key={point.time} cx={48 + index * 76} cy={174 - point.arrivals * 4.4} r="3.5" fill="#fff" stroke="#347fda" strokeWidth="2" />)}
                </>;
              })()}
              {demoHourly.filter((_, index) => index % 2 === 0).map((point, index) => <text key={point.time} x={48 + index * 152} y="204" className="chart-axis" textAnchor="middle">{point.time}</text>)}
            </svg>
          </div>
          <div className="chart-note"><Sparkles size={14} /> Trend uses synthetic demo data. Connect a production data source for live hourly reporting.</div>
        </div>

        <div className="panel status-panel">
          <div className="panel-heading">
            <div><div className="panel-title">Service pulse</div><div className="panel-subtitle">Today's network-wide snapshot</div></div>
            <span className="pulse-tag"><i /> LIVE</span>
          </div>
          <div className="pulse-content">
            <div className="pulse-ring">
              <svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="48" className="ring-track" /><circle cx="60" cy="60" r="48" className="ring-progress" style={{ strokeDasharray: `${Math.min(100, servedRate) * 3.02} 302` }} /></svg>
              <div><strong>{servedRate}%</strong><span>served</span></div>
            </div>
            <div className="pulse-legend">
              <div><span className="pulse-square waiting" /><span>In queue</span><b>{stats.waiting}</b></div>
              <div><span className="pulse-square at-counter" /><span>At counter</span><b>{stats.called}</b></div>
              <div><span className="pulse-square completed" /><span>Completed</span><b>{stats.served}</b></div>
              <div><span className="pulse-square abandoned" /><span>Walk-aways</span><b>{stats.walkaways}</b></div>
            </div>
          </div>
          <div className="pulse-foot"><span>Walk-away rate</span><b className={stats.walkawayRate > 10 ? "danger-text" : ""}>{stats.walkawayRate}%</b><span className="pulse-foot-target">Target &lt; 10%</span></div>
          <div className="pulse-branch-note"><ShieldCheck size={15} /> Operations data is aggregated. No visitor names are stored.</div>
        </div>
      </section>

      <section className="lower-grid">
        <div className="panel branch-panel">
          <div className="panel-heading">
            <div><div className="panel-title">Branch performance</div><div className="panel-subtitle">Live service status by location</div></div>
            <button className="text-button" onClick={() => onSelectBranch("all")}>View all branches <ChevronRight size={15} /></button>
          </div>
          <div className="branch-table-wrap">
            <table className="branch-table">
              <thead><tr><th>BRANCH</th><th>WAITING</th><th>AVG. WAIT</th><th>STAFF</th><th>STATUS</th></tr></thead>
              <tbody>
                {branchMetrics.slice(0, 4).map(({ branch, stats: branchStats }) => {
                  const overloaded = branchStats.waiting >= branch.staffCount;
                  return <tr key={branch.id} onClick={() => onSelectBranch(branch.id)} className="clickable-row">
                    <td><span className={`branch-initial ${branch.prefix.toLowerCase()}`}>{branch.prefix.slice(0, 1)}</span><span className="branch-name-cell"><b>{branch.name}</b><small>{branch.city}</small></span></td>
                    <td><b>{branchStats.waiting}</b><span className="table-soft"> / {branch.staffCount * 2} capacity</span></td>
                    <td>{branchStats.averageWait} min</td>
                    <td><span className="staff-dots"><i /><i /><i /></span>{branch.staffCount} on duty</td>
                    <td><span className={`status-pill ${overloaded ? "status-busy" : "status-open"}`}><i />{overloaded ? "Busy" : "Operational"}</span></td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
          {branchMetrics.length > 4 && <button className="table-footer-link" onClick={() => onSelectBranch("all")}>See all {branches.length} service locations <ChevronRight size={14} /></button>}
        </div>

        <div className="panel queue-preview-panel">
          <div className="panel-heading">
            <div><div className="panel-title">Waiting room</div><div className="panel-subtitle">{waitingNow.length} tickets waiting now</div></div>
            <button className="text-button" onClick={onViewQueue}>Open queue <ChevronRight size={15} /></button>
          </div>
          <div className="mini-queue">
            {queuePreview.map((visitor, index) => (
              <div className="mini-queue-row" key={visitor.id}>
                <span className={`queue-number ${index === 0 ? "queue-number-next" : ""}`}>{visitor.ticket.split("-").slice(-1)[0]}</span>
                <div className="mini-queue-copy"><b>{visitor.ticket}</b><span>{visitor.serviceCategory}</span></div>
                <span className="queue-wait">{durationLabel(Math.floor((Date.now() - new Date(visitor.createdAt).getTime()) / 1000))}</span>
              </div>
            ))}
            {queuePreview.length === 0 && <div className="empty-mini"><Check size={18} /> The queue is clear. Nice work.</div>}
          </div>
          <button className="queue-issue-button" onClick={onTicket}><Plus size={15} /> Issue a new ticket</button>
        </div>
      </section>

      <section className="panel heatmap-panel">
        <div className="panel-heading">
          <div><div className="panel-title">Peak-hour load</div><div className="panel-subtitle">Illustrative branch arrivals by hour · darker means busier</div></div>
          <span className="heatmap-legend"><i /> Lower <i /> Higher</span>
        </div>
        <div className="heatmap-wrap">
          <div className="heatmap-head"><span>BRANCH</span>{heatmapHours.map((hour) => <span key={hour}>{hour}:00</span>)}</div>
          {heatBranches.map(({ branch }, rowIndex) => (
            <div className="heatmap-row" key={branch.id}><b>{branch.name}</b>
              {heatmap[rowIndex % heatmap.length].map((level, index) => <span key={`${branch.id}-${index}`} className={`heat-cell heat-${level}`} aria-label={`${branch.name}, ${heatmapHours[index]}:00, load ${level}`} />)}
            </div>
          ))}
        </div>
      </section>

      <section className="recommendation-bar">
        <div className="recommendation-icon"><Sparkles size={18} /></div>
        <div className="recommendation-copy"><b>Staffing insight <span>DEMO ESTIMATE</span></b><p>{stats.waiting > 8 ? "Queue demand is elevated. Consider moving available staff to the busiest branch." : "Current staffing appears aligned with the live demo queue across branches."} Recommendations are illustrative and based on queue-to-staff ratios only.</p></div>
        <button onClick={() => onSelectBranch("all")}>Review staffing <ChevronRight size={15} /></button>
      </section>
    </>
  );
}

function MetricCard({ label, value, change, icon, tone, foot }: {
  label: string;
  value: string;
  change: string;
  icon: ReactNode;
  tone: string;
  foot: ReactNode;
}) {
  return <article className="metric-card">
    <div className={`metric-icon ${tone}`}>{icon}</div>
    <div className="metric-change">{change}</div>
    <div className="metric-value">{value}</div>
    <div className="metric-label">{label}</div>
    <div className="metric-foot">{foot}</div>
  </article>;
}

function QueueView({ visitors, branches, serviceFilter, setServiceFilter, search, setSearch, onAction, onTicket }: {
  visitors: Visitor[];
  branches: Branch[];
  serviceFilter: string;
  setServiceFilter: (value: string) => void;
  search: string;
  setSearch: (value: string) => void;
  onAction: (visitor: Visitor, action: "call" | "serve" | "walkaway") => void;
  onTicket: () => void;
}) {
  const active = visitors.filter((visitor) => ["WAITING", "CALLED"].includes(visitor.status));
  const waiting = active.filter((visitor) => visitor.status === "WAITING");
  const called = active.filter((visitor) => visitor.status === "CALLED");
  return <>
    <div className="queue-summary-row">
      <div className="queue-summary-card"><span className="summary-square blue" /><div><b>{waiting.length}</b><span>Waiting for service</span></div></div>
      <div className="queue-summary-card"><span className="summary-square green" /><div><b>{called.length}</b><span>Called to counter</span></div></div>
      <div className="queue-summary-card"><span className="summary-square grey" /><div><b>{visitors.filter((visitor) => visitor.status === "SERVED").length}</b><span>Completed today</span></div></div>
      <button className="button button-primary queue-add-button" onClick={onTicket}><Plus size={17} /> Issue ticket</button>
    </div>
    <div className="panel queue-table-panel">
      <div className="table-toolbar">
        <div><h2>Active tickets</h2><p>Call the next visitor or update a ticket status.</p></div>
        <div className="table-filters">
          <label className="search-field"><Search size={16} /><input placeholder="Search tickets…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          <label className="filter-select"><Filter size={15} /><select value={serviceFilter} onChange={(event) => setServiceFilter(event.target.value)}><option>All services</option>{SERVICE_CATEGORIES.map((category) => <option key={category}>{category}</option>)}</select><ChevronDown size={14} /></label>
        </div>
      </div>
      <QueueTable visitors={active} branches={branches} onAction={onAction} />
    </div>
    <div className="queue-tip"><CircleHelp size={16} /><span>Queue actions are shared across this local HQ demo. Production deployments should enforce staff roles and branch-level access.</span></div>
  </>;
}

function QueueTable({ visitors, branches, onAction }: {
  visitors: Visitor[];
  branches: Branch[];
  onAction: (visitor: Visitor, action: "call" | "serve" | "walkaway") => void;
}) {
  return <div className="data-table-wrap"><table className="data-table">
    <thead><tr><th>TICKET</th><th>BRANCH</th><th>SERVICE</th><th>CHECK-IN</th><th>WAIT TIME</th><th>STATUS</th><th>ACTION</th></tr></thead>
    <tbody>{visitors.map((visitor) => {
      const waitingMinutes = Math.max(0, Math.floor((Date.now() - new Date(visitor.createdAt).getTime()) / 60_000));
      return <tr key={visitor.id}>
        <td><b className="ticket-code">{visitor.ticket}</b></td>
        <td>{branchFor(branches, visitor.branchId)?.name ?? "Unknown branch"}</td>
        <td>{visitor.serviceCategory}</td>
        <td>{clockTime(visitor.createdAt)}</td>
        <td><span className={waitingMinutes > 20 ? "wait-overdue" : ""}>{visitor.status === "CALLED" ? "At counter" : `${waitingMinutes} min`}</span></td>
        <td><StatusBadge status={visitor.status} /></td>
        <td><div className="row-actions">
          {visitor.status === "WAITING" && <button className="action-button call-action" onClick={() => onAction(visitor, "call")}>Call next <ChevronRight size={14} /></button>}
          {visitor.status === "CALLED" && <button className="action-button serve-action" onClick={() => onAction(visitor, "serve")}><Check size={14} /> Complete</button>}
          <button className="more-action" aria-label={`Mark ${visitor.ticket} as walk-away`} title="Mark walk-away" onClick={() => onAction(visitor, "walkaway")}><Ellipsis size={18} /></button>
        </div></td>
      </tr>;
    })}</tbody>
  </table>
    {visitors.length === 0 && <div className="empty-state"><TicketCheck size={25} /><b>No active tickets match</b><span>Try changing the filters or issue a new ticket.</span></div>}
  </div>;
}

function StatusBadge({ status }: { status: Visitor["status"] }) {
  const labels = { WAITING: "Waiting", CALLED: "At counter", SERVED: "Served", WALK_AWAY: "Walk-away" };
  return <span className={`status-badge badge-${status.toLowerCase()}`}><i />{labels[status]}</span>;
}

function BranchesView({ metrics, onStaff, onTarget, onAdd, onSelect }: {
  metrics: BranchMetric[];
  onStaff: (branch: Branch, change: number) => void;
  onTarget: (branch: Branch, target: number) => void;
  onAdd: () => void;
  onSelect: (id: string) => void;
}) {
  return <>
    <div className="branch-summary-row">
      <div><span>ACTIVE LOCATIONS</span><b>{metrics.length}</b></div>
      <div><span>VISITORS IN QUEUE</span><b>{metrics.reduce((sum, item) => sum + item.stats.waiting, 0)}</b></div>
      <div><span>STAFF ON DUTY</span><b>{metrics.reduce((sum, item) => sum + item.branch.staffCount, 0)}</b></div>
      <button className="button button-primary" onClick={onAdd}><Plus size={17} /> Add branch</button>
    </div>
    <div className="branch-directory-grid">
      {metrics.map(({ branch, stats }) => {
        const load = Math.min(100, Math.round((stats.waiting / Math.max(1, branch.staffCount * 2)) * 100));
        const overloaded = stats.averageWait > branch.targetWaitMinutes;
        return <article className="panel directory-card" key={branch.id}>
          <div className="directory-top"><span className={`branch-initial large ${branch.prefix.toLowerCase()}`}>{branch.prefix.slice(0, 1)}</span><span className={`status-pill ${overloaded ? "status-busy" : "status-open"}`}><i />{overloaded ? "Attention" : "Operational"}</span></div>
          <h2>{branch.name}</h2><p className="directory-location"><MapPin size={14} /> {branch.city} <span>·</span> {branch.region} region</p>
          <div className="directory-stats"><div><span>WAITING</span><b>{stats.waiting}</b></div><div><span>AVG WAIT</span><b>{stats.averageWait} <small>min</small></b></div><div><span>STAFF</span><b>{branch.staffCount}</b></div></div>
          <div className="load-label"><span>Queue load</span><b>{load}%</b></div><div className="load-track"><i style={{ width: `${load}%` }} className={load > 70 ? "load-high" : ""} /></div>
          <div className="branch-settings">
            <label>Wait target <select value={branch.targetWaitMinutes} onChange={(event) => onTarget(branch, Number(event.target.value))}>{[10, 12, 15, 18, 20, 25, 30].map((n) => <option key={n} value={n}>{n} minutes</option>)}</select></label>
            <div className="staff-control"><span>Staffing</span><button aria-label={`Decrease ${branch.name} staff`} onClick={() => onStaff(branch, -1)}><ChevronLeft size={14} /></button><b>{branch.staffCount}</b><button aria-label={`Increase ${branch.name} staff`} onClick={() => onStaff(branch, 1)}><ChevronRight size={14} /></button></div>
          </div>
          <button className="directory-action" onClick={() => onSelect(branch.id)}>Open branch queue <ChevronRight size={15} /></button>
        </article>;
      })}
    </div>
  </>;
}

function VisitorView({ visitors, branches, search, setSearch, serviceFilter, setServiceFilter, onExport }: {
  visitors: Visitor[];
  branches: Branch[];
  search: string;
  setSearch: (value: string) => void;
  serviceFilter: string;
  setServiceFilter: (value: string) => void;
  onExport: () => void;
}) {
  const filtered = visitors.filter((visitor) =>
    (!search || `${visitor.ticket} ${visitor.serviceCategory}`.toLowerCase().includes(search.toLowerCase()))
    && (serviceFilter === "All services" || visitor.serviceCategory === serviceFilter),
  ).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return <div className="panel visitor-log-panel">
    <div className="table-toolbar">
      <div><h2>Visitor log</h2><p>Ticket activity for the selected date and branches. No names or identity documents are stored.</p></div>
      <div className="table-filters">
        <label className="search-field"><Search size={16} /><input placeholder="Search tickets…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <label className="filter-select"><Filter size={15} /><select value={serviceFilter} onChange={(event) => setServiceFilter(event.target.value)}><option>All services</option>{SERVICE_CATEGORIES.map((category) => <option key={category}>{category}</option>)}</select><ChevronDown size={14} /></label>
        <button className="button button-outline" onClick={onExport}><Download size={16} /> Export CSV</button>
      </div>
    </div>
    <div className="data-table-wrap"><table className="data-table visitor-table"><thead><tr><th>TICKET</th><th>BRANCH</th><th>SERVICE CATEGORY</th><th>CHECKED IN</th><th>WAIT TIME</th><th>STATUS</th></tr></thead>
      <tbody>{filtered.map((visitor) => <tr key={visitor.id}>
        <td><b className="ticket-code">{visitor.ticket}</b></td><td>{branchFor(branches, visitor.branchId)?.name ?? "Unknown branch"}</td><td>{visitor.serviceCategory}</td><td>{clockTime(visitor.createdAt)}</td><td>{durationLabel(visitor.waitSeconds)}</td><td><StatusBadge status={visitor.status} /></td>
      </tr>)}</tbody></table>
      {filtered.length === 0 && <div className="empty-state"><FileClock size={25} /><b>No visitor records found</b><span>Change your search or filters to see more tickets.</span></div>}
    </div>
    <div className="log-footnote"><ShieldCheck size={15} /> Visitor records are demo data stored locally on this server. Configure retention and access controls before using real service data.</div>
  </div>;
}

function TicketModal({ branches, defaultBranch, onClose, onSubmit }: {
  branches: Branch[];
  defaultBranch: string;
  onClose: () => void;
  onSubmit: (branchId: string, category: string) => Promise<void>;
}) {
  const [branchId, setBranchId] = useState(defaultBranch === "all" ? branches[0]?.id ?? "" : defaultBranch);
  const [category, setCategory] = useState(SERVICE_CATEGORIES[0]);
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    await onSubmit(branchId, category);
    setSubmitting(false);
  };
  return <Modal title="Issue a visitor ticket" subtitle="Create a queue ticket without collecting visitor identity." onClose={onClose}>
    <form onSubmit={submit}>
      <label className="form-label">Service branch<select required value={branchId} onChange={(event) => setBranchId(event.target.value)}>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name} · {branch.city}</option>)}</select></label>
      <label className="form-label">Service category<select required value={category} onChange={(event) => setCategory(event.target.value)}>{SERVICE_CATEGORIES.map((item) => <option key={item}>{item}</option>)}</select></label>
      <div className="privacy-note"><ShieldCheck size={16} /><span>Only a ticket number and service category are recorded. Do not enter names, ID numbers, or sensitive personal information.</span></div>
      <div className="modal-actions"><button type="button" className="button button-outline" onClick={onClose}>Cancel</button><button type="submit" className="button button-primary" disabled={submitting}><Plus size={16} />{submitting ? "Issuing…" : "Issue ticket"}</button></div>
    </form>
  </Modal>;
}

function BranchModal({ onClose, onSubmit }: {
  onClose: () => void;
  onSubmit: (input: { name: string; city: string; region: string; prefix: string }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");
  const [prefix, setPrefix] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    await onSubmit({ name, city, region, prefix });
    setSubmitting(false);
  };
  return <Modal title="Add a service branch" subtitle="Add a location to the HQ operations directory." onClose={onClose}>
    <form onSubmit={submit}>
      <label className="form-label">Branch name<input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. North District Office" /></label>
      <div className="form-two-cols"><label className="form-label">City<input required maxLength={80} value={city} onChange={(event) => setCity(event.target.value)} placeholder="City" /></label><label className="form-label">Region<input maxLength={80} value={region} onChange={(event) => setRegion(event.target.value)} placeholder="Region" /></label></div>
      <label className="form-label">Ticket prefix<input required minLength={2} maxLength={4} pattern="[A-Za-z]{2,4}" value={prefix} onChange={(event) => setPrefix(event.target.value.toUpperCase())} placeholder="e.g. ND" /><small>2–4 letters. Tickets will use this prefix.</small></label>
      <div className="modal-actions"><button type="button" className="button button-outline" onClick={onClose}>Cancel</button><button type="submit" className="button button-primary" disabled={submitting}><Plus size={16} />{submitting ? "Adding…" : "Add branch"}</button></div>
    </form>
  </Modal>;
}

function Modal({ title, subtitle, onClose, children }: {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="modal-heading"><div><h2 id="modal-title">{title}</h2><p>{subtitle}</p></div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={18} /></button></div>
      {children}
    </section>
  </div>;
}

export default App;
