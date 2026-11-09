import { useMemo } from 'react';
import { ArrowRight, Download, LoaderCircle, MemoryStick, MessageSquare, Play, Sparkles, Square } from 'lucide-react';
import { archLabel, bytes, pct, tps, usePoll, type CatalogResponse, type CatalogRow } from '../api';
import { FitChip, FuelStrip, Horizon, Readout, Segmented, StatStrip } from '../components';
import { useApp, type Goal } from '../App';
import type { GoalMode } from '@localmax/core';

const CTX_OPTIONS = [4096, 8192, 16384, 32768, 65536, 131072];

export function ModelsPage({ selected }: { selected: string | null }) {
  const { goal, setGoal, preview, setPreview, state } = useApp();
  const q = `/api/catalog?mode=${goal.mode}&ctx=${goal.ctx}&memory=${goal.memory}&workload=${goal.workload}${preview ? `&preview=${preview}` : ''}`;
  // Re-plan every 20s: free memory changes as you open and close apps
  const { data, error } = usePoll<CatalogResponse>(q, 20_000);
  const { data: previews } = usePoll<{ id: string; label: string }[]>('/api/previews', 0);

  // Refresh the "downloaded" marks from the live state without re-planning
  const downloaded = useMemo(() => new Set((state?.downloaded ?? []).map((d) => `${d.modelId}/${d.quantId}`)), [state?.downloaded]);

  const groups = useMemo(() => {
    if (!data) return null;
    const rows = data.rows;
    const isReady = (r: CatalogRow) => downloaded.has(`${r.model.id}/${r.plan.config.quantId}`) && r.plan.fit !== 'no-fit';
    const ready = rows.filter((r) => !preview && isReady(r));
    const fits = rows.filter((r) => r.plan.fit !== 'no-fit' && !ready.includes(r));
    const needsFree = rows.filter((r) => r.plan.fit === 'no-fit' && r.plan.blockedBy === 'free-memory');
    const tooBig = rows.filter((r) => r.plan.fit === 'no-fit' && r.plan.blockedBy !== 'free-memory');
    // Most capable model that still runs comfortably comes first
    const byCapability = (a: CatalogRow, b: CatalogRow) => {
      const fa = a.plan.predicted.genTps >= 8 ? 1 : 0;
      const fb = b.plan.predicted.genTps >= 8 ? 1 : 0;
      return fb - fa || b.model.arch.totalParamsB - a.model.arch.totalParamsB;
    };
    ready.sort(byCapability);
    fits.sort(byCapability);
    tooBig.sort((a, b) => a.model.arch.totalParamsB - b.model.arch.totalParamsB);
    needsFree.sort((a, b) => a.model.arch.totalParamsB - b.model.arch.totalParamsB);
    // Only recommend setups that are both comfortable to use and not crushed by quantisation
    const best = [...ready, ...fits].filter((r) => r.plan.predicted.genTps >= 15 && r.plan.predicted.qualityPct >= 97).sort(byCapability)[0]?.model.id;
    return { ready, fits, needsFree, tooBig, best };
  }, [data, downloaded, preview]);

  const hw = data?.hardware;
  const gpu = hw?.gpus[0];
  const freeNow = data?.rows[0]?.plan.memory.freeNowBytes ?? null;
  const machine = data?.rows[0]?.plan.memory.machineBytes ?? null;
  const swap = hw?.memory.swapUsedBytes ?? 0;
  const machineName = preview ? data?.preview : hw ? (hw.unifiedMemory ? hw.cpu.model : gpu?.model.replace(/^NVIDIA (GeForce )?/, '') ?? hw.cpu.model) : '…';

  return (
    <div className="page">
      <div className="shell">
        <ModelsHero rows={data?.rows ?? null} best={groups?.best} machineName={machineName ?? '…'} />
      </div>

      <Horizon>
        <div className="toolbar" style={{ marginBottom: 20 }}>
          <Segmented<GoalMode>
            value={goal.mode}
            onChange={(mode) => setGoal({ ...goal, mode })}
            options={[
              { value: 'speed', label: 'Max speed', title: 'Fastest setup that keeps at least 96% quality' },
              { value: 'balanced', label: 'Balanced', title: 'Best quality within 25% of the fastest option' },
              { value: 'quality', label: 'Max quality', title: 'Highest quality that still runs at a usable speed' },
            ]}
          />
          {!preview && (
            <Segmented<'free' | 'total'>
              value={goal.memory}
              onChange={(memory) => setGoal({ ...goal, memory })}
              options={[
                { value: 'free', label: <>Free now{freeNow != null ? <span className="mono faint" style={{ fontSize: 11.5 }}>{bytes(freeNow)}</span> : null}</>, title: 'Only plan for memory that is free right now, so nothing swaps to disk' },
                { value: 'total', label: <>Whole machine{machine != null ? <span className="mono faint" style={{ fontSize: 11.5 }}>{bytes(machine)}</span> : null}</>, title: 'Plan as if other apps were closed. Close them before running, or it will swap.' },
              ]}
            />
          )}
          <select
            className="select"
            value={goal.workload}
            onChange={(e) => setGoal({ ...goal, workload: e.target.value as Goal['workload'] })}
            aria-label="What you'll use it for"
            title="Chat: one conversation. Coding agent: long prompts, two requests at once, prompt caching. Batch: many requests for total throughput."
          >
            <option value="chat">For chat</option>
            <option value="agent">For coding agents</option>
            <option value="batch">For batch jobs</option>
          </select>
          <select className="select" value={goal.ctx} onChange={(e) => setGoal({ ...goal, ctx: Number(e.target.value) })} aria-label="Context length">
            {CTX_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {c >= 1024 ? `${c / 1024}K` : c} context
              </option>
            ))}
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
            <span className="label">Plan for</span>
            <select className="select" value={preview} onChange={(e) => setPreview(e.target.value)} aria-label="Preview another machine">
              <option value="">This machine</option>
              {previews?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {hw && (
          <div className="panel machine-strip">
            <div>
              <div className="label">{hw.unifiedMemory ? 'Chip' : 'GPU'}</div>
              <div className="v">{hw.unifiedMemory ? `${hw.cpu.model.replace('Apple ', '')} · ${gpu?.cores ?? '?'}-core GPU` : gpu ? gpu.model.replace(/^NVIDIA (GeForce )?/, '') : 'None'}</div>
            </div>
            <div>
              <div className="label">{hw.unifiedMemory ? 'Unified memory' : 'VRAM + RAM'}</div>
              <div className="v">{hw.unifiedMemory ? bytes(hw.memory.totalBytes, 0) : `${gpu ? bytes(gpu.vramBytes, 0) : '0'} + ${bytes(hw.memory.totalBytes, 0)}`}</div>
            </div>
            <div>
              <div className="label">Bandwidth</div>
              <div className="v">{gpu?.bandwidthGBs ?? hw.memory.bandwidthGBs} GB/s</div>
            </div>
            <div>
              <div className="label">Backend</div>
              <div className="v">{hw.backend.toUpperCase()}</div>
            </div>
            <div>
              <div className="label">Disk free</div>
              <div className="v">{bytes(preview ? hw.disk.freeBytes : state?.diskFreeBytes ?? hw.disk.freeBytes, 0)}</div>
            </div>
          </div>
        )}

        {preview && (
          <div className="info-box">
            <Sparkles size={16} style={{ flex: 'none', marginTop: 2 }} />
            <span>
              Previewing plans for a <strong>{data?.preview}</strong>. Nothing runs in preview mode; it shows how the planner would set each model up on that machine.
            </span>
          </div>
        )}

        {!preview && groups && goal.memory === 'free' && groups.needsFree.length > 0 && (
          <div className="info-box">
            <MemoryStick size={16} style={{ flex: 'none', marginTop: 2 }} />
            <span>
              Other apps are using most of your memory: <strong>{bytes(freeNow)}</strong> is free for a model right now{swap > 2e9 ? <>, and {bytes(swap)} is already swapped to disk</> : null}. Plans only use free memory so nothing gets pushed to swap, which is what makes models crawl. Close some apps and the list updates within 20 seconds.
            </span>
          </div>
        )}
        {!preview && goal.memory === 'total' && (
          <div className="info-box">
            <MemoryStick size={16} style={{ flex: 'none', marginTop: 2 }} />
            <span>
              Planning for the whole machine ({bytes(machine)}), as if no other apps were open. Only <strong>{bytes(freeNow)}</strong> is free right now, so close apps before running anything bigger than that, or macOS will swap and it will run far slower than predicted.
            </span>
          </div>
        )}

        {error && <div className="warn-box">{error}</div>}
        {!groups && !error && (
          <div className="muted" style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 30 }}>
            <LoaderCircle size={16} className="spin" /> Planning every model for your hardware…
          </div>
        )}

        {groups && groups.ready.length > 0 && <Section title="Downloaded" rows={groups.ready} best={groups.best} selected={selected} />}
        {groups && groups.fits.length > 0 && <Section title={groups.ready.length ? 'Also runs well' : 'Runs on this machine'} rows={groups.fits} best={groups.best} selected={selected} />}
        {groups && groups.needsFree.length > 0 && <Section title="Needs more free memory" rows={groups.needsFree} selected={selected} dim />}
        {groups && groups.tooBig.length > 0 && <Section title="Too big for this machine" rows={groups.tooBig} selected={selected} dim />}
      </Horizon>
    </div>
  );
}

/** The loaded model's measured speed, or the best pick's predicted speed, as the one big number. */
function ModelsHero({ rows, best, machineName }: { rows: CatalogRow[] | null; best?: string; machineName: string }) {
  const { state, preview, runModel, pullModel, stopModel, openModel, go } = useApp();
  const s = state?.session;
  const loaded = !preview && s?.state === 'ready' && s.modelId ? rows?.find((r) => r.model.id === s.modelId) : undefined;
  const pick = loaded ?? (best ? rows?.find((r) => r.model.id === best) : undefined);

  if (!pick) {
    return (
      <div className="page-head">
        <div>
          <div className="eyebrow">What can I run</div>
          <h1>Models tuned for your {machineName}</h1>
          <p className="lede">Every model is planned for this exact machine: quant, memory placement, KV cache and speculative decoding. Pick one and press run; the tuner measures the real numbers.</p>
        </div>
      </div>
    );
  }

  const { model, plan } = pick;
  const quant = model.quants.find((q) => q.id === plan.config.quantId)!;
  const isDownloaded = state?.downloaded.some((d) => d.modelId === model.id && d.quantId === quant.id);
  const dl = state?.jobs.find((j) => j.kind === 'download' && j.status === 'running' && j.modelId === model.id);
  const run = state?.jobs.find((j) => j.kind === 'run' && j.status === 'running' && j.modelId === model.id);
  const h = loaded ? s?.headline : null;

  const value = tps(h ? h.genTps : plan.predicted.genTps);
  const measured = !!h?.tuned;
  const source = loaded ? (measured ? 'Measured on your machine' : 'Predicted · tuning was skipped') : preview ? `Predicted for a ${machineName}` : 'Predicted for your machine';
  const qualityPct = h ? h.qualityPct : plan.predicted.qualityPct;
  const qualityEst = (h ? h.qualitySource : plan.predicted.qualitySource) === 'estimate';

  return (
    <section className="hero">
      <Readout value={value} unit={measured ? 'tokens per second' : 'tokens per second · est.'} source={source} />
      <div className="hero-side">
        <div className="kicker">
          {loaded ? 'Loaded' : 'Best pick'} · {model.vendor} · {archLabel(model)}
        </div>
        <h1 className="title">{model.name}</h1>
        {model.blurb && <p className="body-lg">{model.blurb}</p>}
        <StatStrip
          stats={[
            { k: 'quality', v: `${pct(qualityPct)}${qualityEst ? ' est.' : ''}` },
            { k: 'quant', v: quant.id },
            h ? { k: 'score', v: h.score.toLocaleString() } : { k: 'size', v: bytes(quant.sizeBytes) },
          ]}
        />
        {!preview && (
          <div className="hero-actions">
            {loaded ? (
              <>
                <button className="btn primary" onClick={() => go('chat')}>
                  <MessageSquare size={16} /> Start chatting
                </button>
                <button className="btn" onClick={() => stopModel()}>
                  <Square size={14} /> Stop
                </button>
              </>
            ) : (
              <>
                {run ? (
                  <button className="btn primary" disabled>
                    <LoaderCircle size={16} className="spin" /> Starting
                  </button>
                ) : dl ? (
                  <button className="btn primary" disabled>
                    <LoaderCircle size={16} className="spin" /> {dl.progress ? `Downloading ${Math.round((dl.progress.received / dl.progress.total) * 100)}%` : 'Downloading'}
                  </button>
                ) : isDownloaded ? (
                  <button className="btn primary" onClick={() => runModel(model.id)}>
                    <Play size={16} /> Tune & run
                  </button>
                ) : (
                  <button className="btn primary" onClick={() => pullModel(model.id, quant.id)}>
                    <Download size={16} /> Download {bytes(quant.sizeBytes)}
                  </button>
                )}
                <button className="btn" onClick={() => openModel(model.id)}>
                  See the plan
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function Section({ title, rows, best, selected, dim }: { title: string; rows: CatalogRow[]; best?: string; selected: string | null; dim?: boolean }) {
  return (
    <>
      <div className="section-title">
        <h2>{title}</h2>
        <span className="count">{rows.length}</span>
      </div>
      <div className="model-list">
        {rows.map((r, i) => (
          <ModelRow key={r.model.id} row={r} best={r.model.id === best} selected={selected === r.model.id} dim={dim} index={i} />
        ))}
      </div>
    </>
  );
}

function ModelRow({ row, best, selected, dim, index }: { row: CatalogRow; best: boolean; selected: boolean; dim?: boolean; index: number }) {
  const { openModel, state, preview, runModel, pullModel, go } = useApp();
  const { model, plan } = row;
  const quant = model.quants.find((q) => q.id === plan.config.quantId)!;
  const isDownloaded = state?.downloaded.some((d) => d.modelId === model.id && d.quantId === quant.id);
  const dl = state?.jobs.find((j) => j.kind === 'download' && j.status === 'running' && j.modelId === model.id);
  const run = state?.jobs.find((j) => j.kind === 'run' && j.status === 'running' && j.modelId === model.id);
  const running = state?.session.state === 'ready' && state.session.modelId === model.id;
  const unified = !!state && plan.backend === 'metal';

  let action: React.ReactNode = null;
  if (preview || plan.fit === 'no-fit') {
    // No action: preview mode, or the model is too big
  } else if (running) {
    action = (
      <button className="btn sm" onClick={(e) => (e.stopPropagation(), go('chat'))}>
        <MessageSquare size={14} /> Chat
      </button>
    );
  } else if (run) {
    action = (
      <button className="btn sm" disabled>
        <LoaderCircle size={14} className="spin" /> Starting
      </button>
    );
  } else if (dl) {
    const p = dl.progress;
    action = (
      <button className="btn sm" disabled>
        <LoaderCircle size={14} className="spin" /> {p ? `${Math.round((p.received / p.total) * 100)}%` : '…'}
      </button>
    );
  } else if (isDownloaded) {
    action = (
      <button className="btn sm" onClick={(e) => (e.stopPropagation(), runModel(model.id))}>
        <Play size={14} /> Run
      </button>
    );
  } else {
    action = (
      <button className="btn sm" onClick={(e) => (e.stopPropagation(), pullModel(model.id, quant.id))} title={`Download ${quant.id}`}>
        <Download size={14} /> {bytes(quant.sizeBytes)}
      </button>
    );
  }

  return (
    <div
      className={`panel model-row ${selected ? 'selected' : ''} ${dim ? 'dim' : ''}`}
      style={{ animationDelay: `${Math.min(index, 10) * 35}ms` }}
      onClick={() => openModel(model.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && openModel(model.id)}
    >
      <div style={{ minWidth: 0 }}>
        <div className="model-name">
          {model.name}
          {best && <span className="chip brass">Best pick</span>}
          {running && (
            <span className="chip mint">
              <span className="dot pulse" />
              Running
            </span>
          )}
          {model.experimental && <span className="chip outline">Experimental</span>}
        </div>
        <div className="model-sub">
          <span>{model.vendor}</span>
          <span className="faint">·</span>
          <span>{archLabel(model)}</span>
        </div>
      </div>
      <div className="col-quant">
        <div className="mono" style={{ fontSize: 13 }}>
          {quant.id}
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
          {bytes(quant.sizeBytes)} · {pct(plan.predicted.qualityPct)} quality
        </div>
      </div>
      <div className="col-fit">
        <div style={{ marginBottom: 7 }}>
          <FitChip fit={plan.fit} blockedBy={plan.blockedBy} />
        </div>
        <FuelStrip plan={plan} unified={unified} compact />
      </div>
      <div className="speed">
        {plan.fit === 'no-fit' ? (
          <div className="faint mono" style={{ fontSize: 13 }}>
            needs {bytes(plan.memory.gpuBytes + plan.memory.ramBytes, 0)}
          </div>
        ) : (
          <>
            <div>
              <span className="n">{tps(plan.predicted.genTps)}</span>
              <span className="u">tok/s</span>
            </div>
            <div className="q">predicted</div>
          </>
        )}
      </div>
      <div className="row-actions">{action ?? <ArrowRight size={16} className="faint" />}</div>
    </div>
  );
}
