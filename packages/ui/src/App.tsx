import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { LoaderCircle, MoonStar, TriangleAlert } from 'lucide-react';
import { api, bytes, tps, usePoll, type AppState, type HardwareProfile, type Job } from './api';
import { Toast } from './components';
import { ModelsPage } from './pages/Models';
import { ModelDrawer } from './pages/ModelDrawer';
import { ChatPage, type ChatState } from './pages/Chat';
import { MonitorPage } from './pages/Monitor';
import { MachinePage } from './pages/Machine';
import { RunsPage } from './pages/Runs';
import { ComparePage } from './pages/Compare';
import type { GoalMode } from '@localmax/core';

export type Page = 'models' | 'chat' | 'monitor' | 'compare' | 'machine' | 'runs';
export type Goal = { mode: GoalMode; ctx: number; memory: 'free' | 'total'; workload: 'chat' | 'agent' | 'batch' };

interface Ctx {
  state: AppState | null;
  refreshState: () => void;
  goal: Goal;
  setGoal: (g: Goal) => void;
  preview: string;
  setPreview: (p: string) => void;
  openModel: (id: string) => void;
  go: (p: Page) => void;
  notify: (msg: string, error?: boolean) => void;
  runModel: (modelId: string, opts?: { quantId?: string; tune?: boolean; tryMlx?: boolean }) => Promise<void>;
  pullModel: (modelId: string, quantId: string) => Promise<void>;
  stopModel: () => Promise<void>;
  jobFor: (kind: Job['kind'], modelId?: string) => Job | undefined;
}

const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = () => useContext(AppCtx);

const NAV: { id: Page; label: string; key: string }[] = [
  { id: 'models', label: 'Models', key: '1' },
  { id: 'chat', label: 'Chat', key: '2' },
  { id: 'monitor', label: 'Monitor', key: '3' },
  { id: 'compare', label: 'Compare', key: '4' },
  { id: 'runs', label: 'Tuning runs', key: '5' },
  { id: 'machine', label: 'Machine', key: '6' },
];

function readHash(): Page {
  const h = window.location.hash.replace('#/', '') as Page;
  return NAV.some((n) => n.id === h) ? h : 'models';
}

export function App() {
  const [page, setPage] = useState<Page>(readHash);
  const [drawer, setDrawer] = useState<string | null>(null);
  const [goal, setGoalState] = useState<Goal>(() => {
    const fallback: Goal = { mode: 'balanced', ctx: 16384, memory: 'free', workload: 'chat' };
    try {
      return { ...fallback, ...JSON.parse(localStorage.getItem('lmx-goal') ?? '{}') };
    } catch {
      return fallback;
    }
  });
  const [preview, setPreview] = useState('');
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);
  const [chat, setChat] = useState<ChatState>({ messages: [], system: '' });
  const { data: state, refresh: refreshState } = usePoll<AppState>('/api/state', 1000);

  useEffect(() => {
    const on = () => setPage(readHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const go = useCallback((p: Page) => {
    window.location.hash = `#/${p}`;
    setPage(p);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      if (e.key === 'Escape') setDrawer(null);
      const n = NAV.find((x) => x.key === e.key);
      if (n && !e.metaKey && !e.ctrlKey && !e.altKey) go(n.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  const setGoal = (g: Goal) => {
    setGoalState(g);
    try {
      localStorage.setItem('lmx-goal', JSON.stringify(g));
    } catch {}
  };

  const notify = useCallback((msg: string, error?: boolean) => setToast({ msg, error }), []);

  const ctx: Ctx = useMemo(
    () => ({
      state,
      refreshState,
      goal,
      setGoal,
      preview,
      setPreview,
      openModel: setDrawer,
      go,
      notify,
      jobFor: (kind, modelId) => state?.jobs.find((j) => j.kind === kind && (!modelId || j.modelId === modelId)),
      runModel: async (modelId, opts = {}) => {
        try {
          await api('/api/run', { method: 'POST', json: { modelId, mode: goal.mode, ctx: goal.ctx, memory: goal.memory, workload: goal.workload, quantId: opts.quantId, tune: opts.tune !== false, tryMlx: !!opts.tryMlx } });
          setDrawer(modelId);
          refreshState();
        } catch (e) {
          notify((e as Error).message, true);
        }
      },
      pullModel: async (modelId, quantId) => {
        try {
          await api(`/api/models/${modelId}/pull`, { method: 'POST', json: { quantId } });
          refreshState();
        } catch (e) {
          notify((e as Error).message, true);
        }
      },
      stopModel: async () => {
        await api('/api/stop', { method: 'POST', json: {} });
        refreshState();
      },
    }),
    [state, goal, preview, go, notify, refreshState],
  );

  return (
    <AppCtx.Provider value={ctx}>
      <div className="app">
        <header className="topbar">
          <div className="topbar-inner">
            <button className="wordmark" onClick={() => go('models')}>
              EVENT HORIZON
            </button>
            <nav className="nav" aria-label="Main">
              {NAV.map((n) => (
                <button key={n.id} className="nav-pill" onClick={() => go(n.id)} aria-current={page === n.id ? 'page' : undefined} title={`${n.label} (${n.key})`}>
                  {n.label}
                </button>
              ))}
            </nav>
            <div className="topbar-right">
              <EngineStatus />
              <SessionStatusPills />
              <MachineChip />
            </div>
          </div>
        </header>
        <main className="main">
          {page === 'models' && <ModelsPage selected={drawer} />}
          {page === 'chat' && <ChatPage chat={chat} setChat={setChat} />}
          {page === 'monitor' && <MonitorPage />}
          {page === 'compare' && <ComparePage />}
          {page === 'runs' && <RunsPage />}
          {page === 'machine' && <MachinePage />}
        </main>
      </div>
      {drawer && <ModelDrawer modelId={drawer} onClose={() => setDrawer(null)} />}
      {toast && <Toast message={toast.msg} error={toast.error} onClose={() => setToast(null)} />}
    </AppCtx.Provider>
  );
}

function MachineChip() {
  const { state, go } = useApp();
  const { data: hw } = usePoll<HardwareProfile>('/api/hardware', 0);
  if (!hw) return null;
  const gpu = hw.gpus[0];
  const label = hw.unifiedMemory
    ? `${hw.cpu.model.replace('Apple ', '')} · ${bytes(hw.memory.totalBytes, 0)}`
    : `${gpu ? gpu.model.replace(/^NVIDIA (GeForce )?/, '') : hw.cpu.model} · ${bytes(gpu?.vramBytes ?? hw.memory.totalBytes, 0)}`;
  return (
    <button className="machine-chip" style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => go('machine')} title={`Version ${state?.version ?? '…'}`}>
      {label}
    </button>
  );
}

function EngineStatus() {
  const { state, go } = useApp();
  if (!state) return null;
  const job = state.jobs.find((j) => j.kind === 'engine' && j.status === 'running');
  if (state.engine && !job) return null;
  const p = job?.progress;
  return (
    <button className="status-pill" onClick={() => go('machine')} title={job ? (p ? `${bytes(p.received)} of ${bytes(p.total)}` : 'Preparing') : 'Installs automatically on first run'}>
      {job ? <LoaderCircle size={14} className="spin" /> : <TriangleAlert size={14} style={{ color: 'var(--alert)' }} />}
      <span className="name">{job ? 'Installing engine' : 'Engine not installed'}</span>
      {job && (
        <span className={`meter mini-progress ${p ? '' : 'indeterminate'}`} style={{ marginTop: 0 }}>
          <div style={{ width: p ? `${(p.received / p.total) * 100}%` : undefined }} />
        </span>
      )}
    </button>
  );
}

function idleNote(lastUsedAt: number | null, minutes: number): string {
  if (!minutes || !lastUsedAt) return 'Stays loaded until you stop it';
  const left = Math.max(0, lastUsedAt + minutes * 60_000 - Date.now());
  return left < 20_000 ? 'Unloading soon to free memory' : `Unloads after ${Math.ceil(left / 60_000)} more idle min`;
}

const STAGE_LABEL: Record<string, string> = {
  engine: 'Preparing engine',
  plan: 'Planning',
  download: 'Downloading',
  tune: 'Tuning',
  start: 'Loading model',
  ready: 'Ready',
};

function SessionStatusPills() {
  const { state, openModel } = useApp();
  if (!state) return null;
  const s = state.session;
  const job = state.jobs.find((j) => j.kind === 'run' && j.status === 'running');
  const downloads = state.jobs.filter((j) => j.kind === 'download' && j.status === 'running');
  return (
    <>
      {downloads.map((d) => (
        <button key={d.id} className="status-pill" onClick={() => d.modelId && openModel(d.modelId)} title={d.title}>
          <LoaderCircle size={14} className="spin" />
          <span className="name">{d.title}</span>
          <span className="data">{d.progress ? `${Math.round((d.progress.received / d.progress.total) * 100)}%` : '…'}</span>
        </button>
      ))}
      {job ? (
        <button className="status-pill" onClick={() => job.modelId && openModel(job.modelId)} title={job.title}>
          <LoaderCircle size={14} className="spin" />
          <span className="name">
            {STAGE_LABEL[job.stage ?? ''] ?? 'Starting'}
            {job.stage === 'tune' && job.trialRunning ? ` ${job.trialRunning.index + 1}/${job.trialRunning.total}` : ''}
          </span>
        </button>
      ) : s.state === 'ready' && s.modelId ? (
        <button className="status-pill" onClick={() => openModel(s.modelId!)} title={`${s.modelName} loaded. ${idleNote(s.lastUsedAt, s.keepAliveMinutes)}.`}>
          <span className="dot pulse" style={{ color: 'var(--ink)' }} />
          <span className="name">{s.modelName}</span>
          <span className="data">
            {tps(s.headline?.genTps)} tok/s{s.headline?.tuned ? '' : ' est.'}
          </span>
        </button>
      ) : s.state === 'parked' || s.state === 'waking' ? (
        <button className="status-pill" onClick={() => s.modelId && openModel(s.modelId)} title={s.state === 'waking' ? 'Loading back into memory' : 'Memory freed. Reloads when you send a message.'}>
          {s.state === 'waking' ? <LoaderCircle size={14} className="spin" /> : <MoonStar size={14} style={{ color: 'var(--ink-muted)' }} />}
          <span className="name">{s.modelName}</span>
          <span className="data" style={{ color: 'var(--ink-muted)' }}>
            {s.state === 'waking' ? 'reloading' : 'unloaded'}
          </span>
        </button>
      ) : null}
    </>
  );
}
