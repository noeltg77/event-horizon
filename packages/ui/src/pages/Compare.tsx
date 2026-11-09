import { useEffect, useMemo, useState } from 'react';
import { Check, CircleAlert, LoaderCircle, Play, Scale, X } from 'lucide-react';
import { api, bytes, pct, tps, usePoll } from '../api';
import { Horizon, Segmented } from '../components';
import { useApp } from '../App';

type ContenderId = 'localmax' | 'llamacpp' | 'lmstudio' | 'ollama';

interface ContenderStatus {
  id: ContenderId;
  label: string;
  available: boolean;
  version: string | null;
  detail: string;
  setup: string | null;
  hint: string | null;
}

interface PromptResult {
  prompt: string;
  tokens: number;
  ttftMs: number;
  genTps: number;
  engineGenTps: number | null;
  samples?: number[];
  spread?: number;
}

interface ContenderResult {
  id: ContenderId;
  label: string;
  version: string | null;
  ok: boolean;
  error: string | null;
  configNote: string;
  weights?: string;
  qualityPct?: number;
  qualitySource?: string;
  score?: number;
  genTps: number;
  ttftMs: number;
  engineGenTps: number | null;
  peakMemBytes: number;
  loadMs: number;
  prompts: PromptResult[];
}

interface CompareRecord {
  id: string;
  createdAt: string;
  model: { id: string; name: string; quantId: string; sizeBytes: number };
  mode?: 'same-file' | 'best';
  ctx: number;
  maxTokens: number;
  rounds?: number;
  hardware: { cpu: string; gpus: string[]; ramGB: number };
  results: ContenderResult[];
}

const COLORS: Record<ContenderId, string> = {
  localmax: 'var(--ember)',
  llamacpp: 'var(--ink-muted)',
  lmstudio: 'var(--ink-soft)',
  ollama: 'var(--line-strong)',
};

export function ComparePage() {
  const { state, notify, refreshState, go } = useApp();
  const downloaded = state?.downloaded ?? [];
  const [pick, setPick] = useState<string>('');
  const [ctx, setCtx] = useState(8192);
  const [mode, setMode] = useState<'same-file' | 'best'>('same-file');
  const [chosen, setChosen] = useState<Set<ContenderId>>(new Set(['localmax', 'llamacpp', 'lmstudio', 'ollama']));
  const [viewId, setViewId] = useState<string | null>(null);

  // Default to the model every engine can run, else the first download
  useEffect(() => {
    if (pick || !downloaded.length) return;
    const pref = downloaded.find((d) => d.modelId === 'qwen3-4b-2507') ?? downloaded[0];
    setPick(`${pref.modelId}/${pref.quantId}`);
  }, [downloaded, pick]);

  const [modelId, quantId] = pick.split('/');
  const job = state?.jobs.find((j) => j.kind === 'compare');
  const running = job?.status === 'running';
  const { data: contenders, refresh: refreshContenders } = usePoll<ContenderStatus[]>(modelId ? `/api/compare/contenders?model=${modelId}&quant=${quantId}` : null, 0);
  const { data: history, refresh: refreshHistory } = usePoll<CompareRecord[]>('/api/compare/history', 0);

  useEffect(() => {
    if (job && !running) {
      refreshHistory();
      refreshContenders();
    }
  }, [job?.status]); // refresh once when a comparison finishes

  const record: CompareRecord | null = useMemo(() => {
    if (running && job?.data) {
      return {
        id: 'live',
        createdAt: new Date().toISOString(),
        model: { id: modelId, name: job.title, quantId, sizeBytes: 0 },
        mode,
        ctx,
        maxTokens: 256,
        hardware: { cpu: '', gpus: [], ramGB: 0 },
        results: job.data.results as ContenderResult[],
      };
    }
    return history?.find((h) => h.id === viewId) ?? history?.[0] ?? null;
  }, [running, job, history, viewId, modelId, quantId, ctx, mode]);

  const start = async () => {
    const list = (contenders ?? []).filter((c) => c.available && chosen.has(c.id)).map((c) => c.id);
    try {
      await api('/api/compare', { method: 'POST', json: { modelId, quantId, ctx, contenders: list, mode } });
      setViewId(null);
      refreshState();
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  const toggle = (id: ContenderId) =>
    setChosen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const runnable = (contenders ?? []).filter((c) => c.available && chosen.has(c.id));

  return (
    <div className="page">
      <div className="shell page-head">
        <div>
          <div className="eyebrow">Head to head</div>
          <h1>Event Horizon vs the rest</h1>
          <p className="lede">
            The same model file, the same prompts and the same context in each app, one at a time, timed by one stopwatch. Plain llama.cpp with default settings is included as the baseline, since LM Studio and Ollama both run llama.cpp underneath.
          </p>
        </div>
      </div>

      <Horizon>
        <div className="panel tile" style={{ marginBottom: 20 }}>
          {!downloaded.length ? (
            <div className="muted">
              Download a model first.{' '}
              <button className="btn sm" onClick={() => go('models')}>
                Browse models
              </button>
            </div>
          ) : (
            <>
              <div className="toolbar" style={{ marginBottom: 12 }}>
                <Segmented<'same-file' | 'best'>
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: 'same-file', label: 'Same file', title: 'Every engine runs the exact same GGUF: a pure engine comparison' },
                    { value: 'best', label: 'Best setup', title: 'Event Horizon runs its own tuned pick (quant or MLX); everyone is ranked on speed × quality' },
                  ]}
                />
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {mode === 'same-file'
                    ? 'Pure engine test: identical weights everywhere.'
                    : 'Real-world test: Event Horizon uses the quant and backend its tuner chose; others run the file below. Ranked on speed × quality.'}
                </span>
              </div>
              <div className="toolbar" style={{ marginBottom: 16 }}>
                <span className="label">{mode === 'best' ? 'Others run' : 'Model'}</span>
                <select className="select" value={pick} onChange={(e) => setPick(e.target.value)} disabled={running}>
                  {downloaded.map((d) => (
                    <option key={`${d.modelId}/${d.quantId}`} value={`${d.modelId}/${d.quantId}`}>
                      {d.modelId} · {d.quantId} · {bytes(d.sizeBytes)}
                    </option>
                  ))}
                </select>
                <span className="label" style={{ marginLeft: 10 }}>
                  Context
                </span>
                <select className="select" value={ctx} onChange={(e) => setCtx(Number(e.target.value))} disabled={running}>
                  {[4096, 8192, 16384].map((c) => (
                    <option key={c} value={c}>
                      {c / 1024}K
                    </option>
                  ))}
                </select>
                <div style={{ flex: 1 }} />
                {running ? (
                  <button className="btn" onClick={() => api(`/api/jobs/${job!.id}/cancel`, { method: 'POST', json: {} }).then(refreshState)}>
                    <X size={14} /> Cancel
                  </button>
                ) : (
                  <button className="btn primary" onClick={start} disabled={!runnable.length}>
                    <Play size={15} /> Run comparison
                  </button>
                )}
              </div>
              {!downloaded.some((d) => d.modelId === 'qwen3-4b-2507') && (
                <p className="muted" style={{ fontSize: 12.5, margin: '-4px 0 14px' }}>
                  Tip: Qwen3 4B 2507 uses an architecture every app supports, so it makes the fairest comparison. Newer models may not load in older LM Studio or Ollama versions.
                </p>
              )}
              <div className="grid-2">
                {(contenders ?? []).map((c) => {
                  const on = chosen.has(c.id) && c.available;
                  const res = running ? (job?.data?.results as ContenderResult[] | undefined)?.find((r) => r.id === c.id) : undefined;
                  const current = running && job?.data?.current === c.id;
                  return (
                    <button
                      key={c.id}
                      className="status-card"
                      style={{ borderColor: on ? COLORS[c.id] : undefined, opacity: c.available ? 1 : 0.6, cursor: c.available && !running ? 'pointer' : 'default', padding: 14 }}
                      onClick={() => c.available && !running && toggle(c.id)}
                      aria-pressed={on}
                    >
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <span className="row" style={{ fontWeight: 650, fontSize: 14 }}>
                          <span className="dot" style={{ color: COLORS[c.id] }} />
                          {c.label}
                        </span>
                        {current ? (
                          <LoaderCircle size={15} className="spin" style={{ color: 'var(--brass)' }} />
                        ) : res ? (
                          res.ok ? (
                            <span className="mono" style={{ color: 'var(--brass)' }}>
                              {tps(res.genTps)} tok/s
                            </span>
                          ) : (
                            <CircleAlert size={15} style={{ color: 'var(--oxide)' }} />
                          )
                        ) : on ? (
                          <Check size={15} style={{ color: 'var(--ink-muted)' }} />
                        ) : null}
                      </div>
                      <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
                        {current ? job?.detail : c.detail}
                        {c.version ? <span className="faint"> · {c.version}</span> : null}
                      </div>
                      {c.available && c.setup && on && !running && <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>{c.setup}</div>}
                      {!c.available && c.hint && <div style={{ fontSize: 12, marginTop: 6, color: 'var(--ink-soft)' }}>{c.hint}</div>}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {record && record.results.length > 0 && <Results record={record} live={running} />}

        {running && job && job.logs.length > 0 && (
          <div className="log" style={{ marginTop: 14 }}>
            {job.logs.slice(-12).join('\n')}
          </div>
        )}
        {job?.status === 'error' && <div className="warn-box" style={{ marginTop: 14 }}>{job.error}</div>}

        {history && history.length > 1 && (
          <>
            <div className="section-title">
              <h2>Earlier comparisons</h2>
              <span className="count">{history.length}</span>
            </div>
            <div className="panel" style={{ overflow: 'hidden' }}>
              <table className="runs-table">
                <tbody>
                  {history.map((h) => {
                    const lm = h.results.find((r) => r.id === 'localmax' && r.ok);
                    return (
                      <tr key={h.id} onClick={() => setViewId(h.id)} style={{ cursor: 'pointer', background: record?.id === h.id ? 'var(--panel-2)' : undefined }}>
                        <td className="muted">{new Date(h.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</td>
                        <td>
                          <strong>{h.model.name}</strong> <span className="faint mono" style={{ fontSize: 11.5 }}>{h.model.quantId}</span>
                        </td>
                        <td className="muted">{h.results.map((r) => r.label.replace(' (tuned)', '')).join(' · ')}</td>
                        <td className="num">{lm ? `${tps(lm.genTps)} tok/s` : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Horizon>
    </div>
  );
}

function Results({ record, live }: { record: CompareRecord; live: boolean }) {
  const ok = record.results.filter((r) => r.ok);
  const lm = ok.find((r) => r.id === 'localmax');
  const bestMode = record.mode === 'best';
  const workloads = ok[0]?.prompts.map((p) => p.prompt) ?? [];
  const maxTps = Math.max(1, ...ok.flatMap((r) => r.prompts.map((p) => p.genTps)));

  // How much each engine varies run to run. A difference smaller than this isn't a real difference.
  const spreadOf = (r: ContenderResult) => {
    const s = r.prompts.map((p) => p.spread ?? 0).filter((x) => x > 0);
    return s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0.1; // single runs: assume 10% noise
  };
  // Headline: localmax relative to each other engine, on the median and on its best workload
  const vs = lm
    ? ok
        .filter((r) => r.id !== 'localmax')
        .map((r) => {
          const ratios = r.prompts.map((p, i) => (lm.prompts[i]?.genTps ?? 0) / Math.max(0.1, p.genTps));
          const noise = Math.max(0.05, (spreadOf(lm) + spreadOf(r)) / 2);
          // Best-setup mode ranks on score (speed × quality); same-file mode on speed alone
          const median = bestMode && lm.score && r.score ? lm.score / Math.max(1, r.score) : lm.genTps / Math.max(0.1, r.genTps);
          const best = Math.max(...ratios);
          return { label: r.label, median, best, bestOn: workloads[ratios.indexOf(best)], noise, same: Math.abs(median - 1) <= noise };
        })
    : [];

  return (
    <div className="panel tile" style={{ marginBottom: 20 }}>
      <div className="tile-head" style={{ marginBottom: 4 }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Scale size={17} style={{ color: 'var(--ink-muted)' }} />
          {live ? 'Running…' : `${record.model.name} · ${record.model.quantId}`}
        </h2>
        {!live && (
          <span className="faint mono" style={{ fontSize: 11.5 }}>
            {(record.ctx / 1024).toFixed(0)}K ctx · {record.maxTokens} tokens/prompt · {record.rounds ?? 1} round{(record.rounds ?? 1) > 1 ? 's' : ''} · {new Date(record.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
          </span>
        )}
      </div>

      {vs.length > 0 && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '10px 0 18px' }}>
          {vs.map((v) => (
            <div key={v.label} className="panel" style={{ padding: '10px 14px', background: 'var(--panel-2)' }}>
              <div className="label">vs {v.label}</div>
              <div className="mono" style={{ fontSize: 22, marginTop: 2, color: v.same ? 'var(--text)' : v.median > 1 ? 'var(--brass)' : 'var(--oxide)' }}>
                {v.same ? 'Same speed' : `${v.median.toFixed(2)}×`}
              </div>
              <div className="faint" style={{ fontSize: 11.5 }}>
                {v.same ? `${v.median.toFixed(2)}× is within run-to-run noise (±${Math.round(v.noise * 100)}%)` : bestMode ? 'on speed × quality' : 'typical'}
                {v.best > v.median * (1 + v.noise) * 1.1 && v.best > 1 + v.noise ? ` · up to ${v.best.toFixed(1)}× on ${v.bestOn.toLowerCase()}` : ''}
              </div>
            </div>
          ))}
        </div>
      )}

      {workloads.map((w, wi) => (
        <div key={w} style={{ marginBottom: 14 }}>
          <div className="label" style={{ marginBottom: 6 }}>
            {w} · tokens per second
          </div>
          {ok.map((r) => {
            const p = r.prompts[wi];
            return (
              <div key={r.id} className="trial" style={{ gridTemplateColumns: '170px 1fr 104px', borderTop: 0, padding: '3px 0' }}>
                <span style={{ fontSize: 13, fontWeight: r.id === 'localmax' ? 650 : 500 }}>
                  {r.label}
                  {bestMode && r.weights ? <span className="faint mono" style={{ fontSize: 10.5 }}> {r.weights}</span> : null}
                </span>
                <div className="trial-bar" style={{ height: 10 }}>
                  <div style={{ width: `${((p?.genTps ?? 0) / maxTps) * 100}%`, background: COLORS[r.id] }} />
                </div>
                <span className="mono" style={{ textAlign: 'right', fontSize: 13 }} title={p?.samples ? `Runs: ${p.samples.join(', ')} tok/s` : undefined}>
                  {tps(p?.genTps)}
                  {p?.spread ? <span className="faint" style={{ fontSize: 10.5 }}> ±{Math.round((p.spread / 2) * 100)}%</span> : null}
                </span>
              </div>
            );
          })}
        </div>
      ))}

      <table className="runs-table" style={{ marginTop: 6 }}>
        <thead>
          <tr>
            <th>Engine</th>
            <th style={{ textAlign: 'right' }}>Typical</th>
            {bestMode && <th>Weights</th>}
            {bestMode && <th style={{ textAlign: 'right' }}>Quality</th>}
            {bestMode && <th style={{ textAlign: 'right' }}>Score</th>}
            <th style={{ textAlign: 'right' }}>First token</th>
            <th style={{ textAlign: 'right' }}>Load</th>
            <th style={{ textAlign: 'right' }}>Peak memory</th>
            <th>Setup</th>
          </tr>
        </thead>
        <tbody>
          {record.results.map((r) => (
            <tr key={r.id}>
              <td>
                <span className="dot" style={{ color: COLORS[r.id], marginRight: 7 }} />
                <strong>{r.label}</strong>
                {r.version && <div className="faint mono" style={{ fontSize: 11 }}>{r.version}</div>}
              </td>
              {r.ok ? (
                <>
                  <td className="num" style={{ color: r.id === 'localmax' ? 'var(--brass)' : undefined }}>{tps(r.genTps)} tok/s</td>
                  {bestMode && <td className="mono" style={{ fontSize: 12 }}>{r.weights ?? record.model.quantId}</td>}
                  {bestMode && (
                    <td className="num">
                      {r.qualityPct != null ? pct(r.qualityPct) : '—'}
                      {r.qualitySource && <div className="faint" style={{ fontSize: 10.5 }}>{r.qualitySource}</div>}
                    </td>
                  )}
                  {bestMode && <td className="num" style={{ color: r.id === 'localmax' ? 'var(--brass)' : undefined }}>{r.score?.toLocaleString() ?? '—'}</td>}
                  <td className="num">{r.ttftMs} ms</td>
                  <td className="num">{(r.loadMs / 1000).toFixed(1)} s</td>
                  <td className="num">{r.peakMemBytes ? bytes(r.peakMemBytes) : '—'}</td>
                  <td className="muted" style={{ fontSize: 12, maxWidth: 360 }}>{r.configNote}</td>
                </>
              ) : (
                <td colSpan={bestMode ? 8 : 5} style={{ color: 'var(--oxide)', fontSize: 12.5 }}>
                  {r.error}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="faint" style={{ fontSize: 12, margin: '12px 0 0' }}>
        Typical = median of the three workloads; each workload is the median of several runs, with ± showing how much it varied. Differences inside that range are noise, not a win. Generation speed is timed on the token stream from first to last token, the same way for every engine; temperature 0, thinking off where supported, a warm-up request first, and only one engine loaded at a time.
      </p>
    </div>
  );
}
