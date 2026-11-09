import { useState } from 'react';
import { Download, LoaderCircle, MemoryStick, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { CopyBlock, Horizon } from '../components';
import { api, bytes, eta, usePoll, type HardwareProfile } from '../api';
import { useApp } from '../App';

export function MachinePage() {
  const { state, refreshState, notify } = useApp();
  const [refreshing, setRefreshing] = useState(false);
  const { data: hw, refresh } = usePoll<HardwareProfile>('/api/hardware', 0);
  const { data: engines, refresh: refreshEngines } = usePoll<{ mlx: { supported: boolean; installed: { mlxLmVersion: string; uvVersion: string; installedAt: string } | null } }>('/api/engines', 5000);
  const { data: wired, refresh: refreshWired } = usePoll<WiredInfo>('/api/wired', 0);
  const [applying, setApplying] = useState(false);
  const mlxJob = state?.jobs.find((j) => j.kind === 'engine' && j.title.includes('MLX'));
  const installMlx = async () => {
    try {
      await api('/api/engines/mlx/install', { method: 'POST', json: {} });
      refreshState();
      refreshEngines();
    } catch (e) {
      notify((e as Error).message, true);
    }
  };
  const setWired = async (mb: number) => {
    setApplying(true);
    try {
      await api('/api/wired', { method: 'POST', json: { mb } });
      notify(mb === 0 ? 'GPU memory limit back to the macOS default' : `GPU can now use up to ${(mb / 1024).toFixed(1)} GB. Plans updated.`);
      refreshWired();
      refresh();
    } catch (e) {
      if ((e as Error).message !== 'Cancelled') notify((e as Error).message, true);
    } finally {
      setApplying(false);
    }
  };
  const engineJob = state?.jobs.find((j) => j.kind === 'engine');
  const installing = engineJob?.status === 'running';

  const rescan = async () => {
    setRefreshing(true);
    try {
      await api('/api/hardware?refresh=1');
      refresh();
    } finally {
      setRefreshing(false);
    }
  };

  const install = async (latest: boolean) => {
    try {
      await api('/api/engine/install', { method: 'POST', json: { latest } });
      refreshState();
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  return (
    <div className="page">
      <div className="shell page-head">
        <div>
          <div className="eyebrow">Spec sheet</div>
          <h1>Your machine</h1>
          <p className="lede">What the profiler found. Every plan is built from these numbers; estimates are marked so you know which ones to trust less.</p>
        </div>
        <button className="btn" onClick={rescan} disabled={refreshing}>
          <RefreshCw size={14} className={refreshing ? 'spin' : ''} /> Re-scan
        </button>
      </div>

      <Horizon>
        <div className="grid-2" style={{ alignItems: 'start' }}>
          <div className="panel tile">
            <h2 style={{ marginBottom: 14 }}>Hardware</h2>
            {!hw ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <div className="spec">
                <Row k="System" v={hw.os.name} sub={`${hw.os.platform} ${hw.os.arch}`} />
                <Row
                  k="CPU"
                  v={hw.cpu.model}
                  sub={`${hw.cpu.physicalCores} cores${hw.cpu.performanceCores !== hw.cpu.physicalCores ? ` · ${hw.cpu.performanceCores} performance` : ''} · ${hw.cpu.logicalCores} threads${hw.cpu.avx512 ? ' · AVX-512' : hw.cpu.avx2 ? ' · AVX2' : hw.cpu.neon ? ' · NEON' : ''}`}
                />
                <Row
                  k="Memory"
                  v={`${bytes(hw.memory.totalBytes, 0)} ${hw.memory.type ?? ''}`}
                  sub={`${hw.memory.bandwidthGBs} GB/s${hw.memory.bandwidthSource === 'estimate' ? ' (estimated)' : ''}${hw.memory.speedMTs ? ` · ${hw.memory.speedMTs} MT/s` : ''}${hw.memory.channels && !hw.unifiedMemory ? ` · ${hw.memory.channels} channel${hw.memory.channels > 1 ? 's' : ''}` : ''}`}
                />
                {hw.gpus.length === 0 && <Row k="GPU" v="None detected" sub="Models run on the CPU" />}
                {hw.gpus.map((g, i) => (
                  <Row
                    key={i}
                    k={hw.unifiedMemory ? 'GPU' : `GPU ${hw.gpus.length > 1 ? i + 1 : ''}`}
                    v={g.model}
                    sub={[
                      hw.unifiedMemory ? `Metal may use ${bytes(g.vramBytes)}` : `${bytes(g.vramBytes)} VRAM${g.vramFreeBytes != null ? ` · ${bytes(g.vramFreeBytes)} free` : ''}`,
                      `${g.bandwidthGBs} GB/s${g.bandwidthSource === 'estimate' ? ' (est.)' : ''}`,
                      g.cores ? `${g.cores} cores` : null,
                      g.pcie ? `PCIe ${g.pcie.gen}.0 x${g.pcie.width}` : null,
                      g.driver ? `driver ${g.driver}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  />
                ))}
                <Row k="Backend" v={hw.backend.toUpperCase()} sub={hw.unifiedMemory ? 'Unified memory: no VRAM/RAM split to manage' : undefined} />
                <Row k="Disk" v={`${bytes(hw.disk.freeBytes, 0)} free`} sub={`of ${bytes(hw.disk.totalBytes, 0)} · ${hw.disk.kind.toUpperCase()} · ~${hw.disk.readMBs} MB/s (est.)`} />
              </div>
            )}
            {hw?.notes.map((n) => (
              <p key={n} className="muted" style={{ fontSize: 12.5, margin: '10px 0 0' }}>
                ! {n}
              </p>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="panel tile">
              <div className="tile-head">
                <h2>Engine</h2>
                {state?.engine && (
                  <span className="chip mint">
                    <ShieldCheck size={12} /> SHA256 verified
                  </span>
                )}
              </div>
              {state?.engine ? (
                <div className="spec">
                  <Row k="Build" v={`llama.cpp ${state.engine.tag}`} sub={state.engine.tag === state.pinnedEngineTag ? 'The build Event Horizon is tested against' : `Tested build is ${state.pinnedEngineTag}`} />
                  <Row k="Variant" v={state.engine.suffix} sub={`${state.engine.backend.toUpperCase()} backend`} />
                  <Row k="Installed" v={new Date(state.engine.installedAt).toLocaleString()} />
                </div>
              ) : (
                <p className="muted" style={{ marginTop: 0 }}>
                  Not installed yet. It downloads automatically the first time you run a model (about 17 MB on a Mac, more for CUDA on Windows), or install it now.
                </p>
              )}
              {installing && engineJob?.progress && (
                <div style={{ margin: '12px 0' }}>
                  <div className="mini-progress">
                    <div style={{ width: `${(engineJob.progress.received / engineJob.progress.total) * 100}%` }} />
                  </div>
                  <div className="faint mono" style={{ fontSize: 11, marginTop: 5 }}>
                    {bytes(engineJob.progress.received)} / {bytes(engineJob.progress.total)} · {eta(engineJob.progress.received, engineJob.progress.total, engineJob.progress.speed)}
                  </div>
                </div>
              )}
              {engineJob?.status === 'error' && <div className="warn-box" style={{ marginTop: 12 }}>{engineJob.error}</div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                <button className={`btn sm ${state?.engine ? '' : 'primary'}`} onClick={() => install(false)} disabled={installing}>
                  {installing ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}
                  {state?.engine ? `Reinstall ${state.pinnedEngineTag}` : `Install llama.cpp ${state?.pinnedEngineTag ?? ''}`}
                </button>
                <button className="btn sm ghost" onClick={() => install(true)} disabled={installing} title="Newest llama.cpp build; not yet tested with Event Horizon">
                  Try latest build
                </button>
              </div>
            </div>

            {engines?.mlx.supported && (
              <div className="panel tile">
                <div className="tile-head">
                  <h2>MLX engine</h2>
                  {engines.mlx.installed && <span className="chip mint">mlx-lm {engines.mlx.installed.mlxLmVersion}</span>}
                </div>
                <p className="muted" style={{ marginTop: 0, fontSize: 13.5 }}>
                  Apple’s own machine-learning framework, often faster than llama.cpp on Macs. Tick “Also try MLX” when you tune a model and the tuner measures both and keeps the faster one, adjusted for quality. Installs into Event Horizon’s own folder with its own Python, so it never touches your system.
                </p>
                {mlxJob?.status === 'running' ? (
                  <div className="faint mono" style={{ fontSize: 12 }}>
                    <LoaderCircle size={13} className="spin" style={{ verticalAlign: -2 }} /> {mlxJob.logs.at(-1) ?? 'Starting…'}
                  </div>
                ) : !engines.mlx.installed ? (
                  <button className="btn sm" onClick={installMlx}>
                    <Download size={14} /> Install MLX (a few hundred MB)
                  </button>
                ) : null}
                {mlxJob?.status === 'error' && <div className="warn-box" style={{ marginTop: 10 }}>{mlxJob.error}</div>}
              </div>
            )}

            {wired?.supported && (
              <div className="panel tile">
                <div className="tile-head">
                  <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <MemoryStick size={17} /> GPU memory limit
                  </h2>
                  <span className="chip outline">{(wired.currentMb / 1024).toFixed(1)} GB now</span>
                </div>
                <p className="muted" style={{ marginTop: 0, fontSize: 13.5 }}>
                  macOS lets the GPU use about {Math.round((wired.defaultMb / wired.totalMb) * 100)}% of your {(wired.totalMb / 1024).toFixed(0)} GB by default. Raising it to {(wired.recommendedMb / 1024).toFixed(1)} GB (leaving 4 GB for macOS) lets bigger models run entirely on the GPU instead of being split with the much slower CPU. It needs your administrator password and resets when you restart the Mac.
                </p>
                {wired.raised ? (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span className="chip mint">Raised to {(wired.currentMb / 1024).toFixed(1)} GB until you restart</span>
                    <button className="btn sm ghost" onClick={() => setWired(0)} disabled={applying}>
                      Back to default
                    </button>
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                      <button className="btn sm primary" onClick={() => setWired(wired.recommendedMb)} disabled={applying} title="macOS will ask for your password">
                        {applying ? <LoaderCircle size={14} className="spin" /> : <MemoryStick size={14} />} Raise to {(wired.recommendedMb / 1024).toFixed(1)} GB
                      </button>
                    </div>
                    <div className="faint" style={{ fontSize: 12, marginBottom: 6 }}>
                      Or run it yourself in Terminal:
                    </div>
                    <CopyBlock text={wired.command} />
                  </>
                )}
              </div>
            )}

            <div className="panel tile">
              <div className="tile-head">
                <h2>Downloaded models</h2>
                <span className="faint mono" style={{ fontSize: 12 }}>
                  {bytes((state?.downloaded ?? []).reduce((s, d) => s + d.sizeBytes, 0))}
                </span>
              </div>
              {!state?.downloaded.length ? (
                <p className="muted" style={{ margin: 0 }}>
                  None yet.
                </p>
              ) : (
                state.downloaded.map((d) => (
                  <div key={`${d.modelId}/${d.quantId}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderTop: '1px solid var(--line-soft)' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600 }}>{d.modelId}</div>
                      <div className="faint mono" style={{ fontSize: 11.5 }}>
                        {d.quantId} · {bytes(d.sizeBytes)}
                      </div>
                    </div>
                    <button
                      className="btn sm icon ghost danger"
                      title="Delete"
                      onClick={async () => {
                        if (!confirm(`Delete ${d.modelId} ${d.quantId} (${bytes(d.sizeBytes)})? You can download it again later.`)) return;
                        try {
                          await api(`/api/models/${d.modelId}/${d.quantId}`, { method: 'DELETE' });
                          refreshState();
                        } catch (e) {
                          notify((e as Error).message, true);
                        }
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </Horizon>
    </div>
  );
}

interface WiredInfo {
  supported: boolean;
  totalMb: number;
  currentMb: number;
  defaultMb: number;
  recommendedMb: number;
  raised: boolean;
  command: string;
}

function Row({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <>
      <div className="k">{k}</div>
      <div className="v">
        {v}
        {sub && <span className="sub">{sub}</span>}
      </div>
    </>
  );
}
