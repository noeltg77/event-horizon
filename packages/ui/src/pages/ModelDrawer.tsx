import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Cpu,
  Download,
  Gauge as GaugeIcon,
  Layers,
  LoaderCircle,
  MemoryStick,
  MessageSquare,
  Play,
  RotateCcw,
  Square,
  Trash2,
  TriangleAlert,
  X,
  Zap,
  Rows3,
  Sparkles,
} from 'lucide-react';
import { api, archLabel, bytes, eta, pct, tps, usePoll, type Job, type Plan } from '../api';
import { CopyBlock, FitChip, FuelStrip, Readout, StatStrip } from '../components';
import { useApp } from '../App';

const REASON_ICON = {
  quant: Layers,
  placement: MemoryStick,
  kv: Rows3,
  ctx: Rows3,
  spec: Zap,
  threads: Cpu,
  batch: GaugeIcon,
  warn: TriangleAlert,
} as const;

interface PlanResponse {
  plan: Plan;
  command: string;
  partialBytes: number;
  quality: {
    measured: { qualityPct: number; kld: number; samePct: number; measuredAt: string } | null;
    canMeasure: boolean;
    reason: string;
    referenceBytes: number | null;
    referenceOnDisk: boolean;
  };
  mlx: { supported: boolean; installed: boolean; variants: { id: string; bits: number; sizeBytes: number }[] };
}

export function ModelDrawer({ modelId, onClose }: { modelId: string; onClose: () => void }) {
  const { goal, setGoal, preview, state, runModel, pullModel, stopModel, go, notify, refreshState } = useApp();
  const [quantOverride, setQuantOverride] = useState<string | null>(null);
  const [skipTune, setSkipTune] = useState(false);
  const [tryMlx, setTryMlx] = useState(false);
  useEffect(() => setQuantOverride(null), [modelId]);

  const url = `/api/plan/${modelId}?mode=${goal.mode}&ctx=${goal.ctx}&memory=${goal.memory}&workload=${goal.workload}${quantOverride ? `&quant=${quantOverride}` : ''}${preview ? `&preview=${preview}` : ''}`;
  const { data, refresh: refreshPlan } = usePoll<PlanResponse>(url, 0);
  const qualityJob = state?.jobs.find((j) => j.kind === 'quality' && j.modelId === modelId);
  useEffect(() => {
    if (qualityJob && qualityJob.status !== 'running') refreshPlan();
  }, [qualityJob?.status]); // re-plan once a quality measurement lands
  const measureQuality = async () => {
    try {
      await api(`/api/quality/${modelId}/${quantId}`, { method: 'POST', json: {} });
      refreshState();
    } catch (e) {
      notify((e as Error).message, true);
    }
  };
  const { data: catalog } = usePoll<{ rows: { model: any }[] }>(`/api/catalog?mode=${goal.mode}&ctx=${goal.ctx}`, 0);
  const model = catalog?.rows.find((r) => r.model.id === modelId)?.model;

  const plan = data?.plan;
  const runJob = state?.jobs.find((j) => j.kind === 'run' && j.modelId === modelId);
  const dlJob = state?.jobs.find((j) => j.kind === 'download' && j.modelId === modelId && j.status === 'running');
  const session = state?.session;
  const isRunning = session?.state === 'ready' && session.modelId === modelId;
  const quantId = plan?.config.quantId;
  const downloaded = !!state?.downloaded.some((d) => d.modelId === modelId && d.quantId === quantId);
  const unified = plan?.backend === 'metal';
  // Show run progress while a run is going, or its result if it is the latest thing that happened
  const showRun = runJob && (runJob.status === 'running' || isRunning || (runJob.status === 'error' && !isRunning));

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" aria-label={model?.name ?? 'Model'}>
        <div className="drawer-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="eyebrow">{model ? `${model.vendor} · ${archLabel(model)}` : ' '}</div>
            <h2>{model?.name ?? plan?.modelName ?? '…'}</h2>
            {model && <p style={{ margin: '10px 0 0', fontSize: 15, color: 'var(--ink-soft)' }}>{model.blurb}</p>}
            {model && (
              <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
                {plan && <FitChip fit={plan.fit} blockedBy={plan.blockedBy} />}
                {model.tags.map((t: string) => (
                  <span key={t} className="chip outline">
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>
          <button className="btn icon ghost" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="drawer-body">
          {showRun && runJob ? (
            <RunProgress job={runJob} running={isRunning} headline={isRunning ? session?.headline ?? null : null} />
          ) : null}

          {!plan ? (
            <div className="muted" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <LoaderCircle size={16} className="spin" /> Planning…
            </div>
          ) : (
            <>
              {!showRun && (
                <div className="drawer-readout">
                  <Readout size="lg" value={tps(plan.predicted.genTps)} unit="tokens per second · est." source="Predicted" />
                  <div className="readout-stats">
                    <Stat k="Quality" v={pct(plan.predicted.qualityPct)} sub={plan.predicted.qualitySource === 'native' ? 'native' : plan.predicted.qualitySource === 'measured' ? 'measured' : 'est.'} />
                    <Stat k="Score" v={plan.predicted.score.toLocaleString()} />
                    <Stat k="Prompt" v={tps(plan.predicted.promptTps)} sub="tok/s" />
                    <Stat k="Context" v={`${Math.round(plan.config.ctx / 1024)}K`} sub="tokens" />
                    <Stat k="Download" v={bytes(plan.memory.weightsBytes + plan.memory.extraBytes)} />
                    <Stat k="Memory" v={bytes(plan.memory.gpuBytes + plan.memory.ramBytes)} />
                  </div>
                </div>
              )}
              {!showRun && plan.calibration && (
                <p className="faint" style={{ fontSize: 12, margin: '-8px 0 14px' }}>
                  Speed prediction calibrated from {plan.calibration.runs} tuning run{plan.calibration.runs > 1 ? 's' : ''} on this machine (×{plan.calibration.factor.toFixed(2)}).
                </p>
              )}

              {data && !preview && plan.predicted.qualitySource !== 'native' && (
                <div className="panel" style={{ padding: '12px 14px', marginBottom: 14, display: 'flex', gap: 12, alignItems: 'center' }}>
                  <div style={{ flex: 1, fontSize: 13 }}>
                    {data.quality.measured ? (
                      <>
                        <strong>Quality measured: {pct(data.quality.measured.qualityPct)}</strong>
                        <div className="faint" style={{ fontSize: 12 }}>
                          Mean KL divergence {data.quality.measured.kld.toFixed(4)} against Q8_0
                          {Number.isFinite(data.quality.measured.samePct) ? ` · top token matches ${data.quality.measured.samePct.toFixed(1)}%` : ''}
                        </div>
                      </>
                    ) : qualityJob?.status === 'running' ? (
                      <>
                        <strong>Measuring quality…</strong>
                        <div className="faint" style={{ fontSize: 12 }}>{qualityJob.progress ? `${qualityJob.progress.label}: ${Math.round((qualityJob.progress.received / Math.max(1, qualityJob.progress.total)) * 100)}%` : qualityJob.logs.at(-1)}</div>
                      </>
                    ) : (
                      <>
                        <strong>Quality is an estimate</strong>
                        <div className="faint" style={{ fontSize: 12 }}>
                          {data.quality.canMeasure
                            ? `Measure it against the Q8_0 reference with llama.cpp's KL-divergence tool (about a minute${data.quality.referenceOnDisk ? '' : `, plus a ${bytes(data.quality.referenceBytes)} download`}).`
                            : data.quality.reason}
                        </div>
                        {qualityJob?.status === 'error' && <div style={{ color: 'var(--oxide)', fontSize: 12 }}>{qualityJob.error?.split('\n')[0]}</div>}
                      </>
                    )}
                  </div>
                  {!data.quality.measured && data.quality.canMeasure && qualityJob?.status !== 'running' && downloaded && (
                    <button className="btn sm" onClick={measureQuality}>
                      Measure quality
                    </button>
                  )}
                </div>
              )}

              {plan.warnings.map((w) => (
                <div key={w} className="warn-box">
                  <TriangleAlert size={16} />
                  <span>{w}</span>
                </div>
              ))}

              <div className="label" style={{ margin: '4px 0 10px' }}>
                Where it lives
              </div>
              <FuelStrip plan={plan} unified={!!unified} />

              <div className="label" style={{ margin: '24px 0 4px' }}>
                Why this setup
              </div>
              <div className="reasons">
                {plan.reasons.map((r, i) => {
                  const Icon = REASON_ICON[r.kind] ?? Sparkles;
                  return (
                    <div className="reason" key={i}>
                      <div className={`reason-icon ${r.kind === 'warn' ? 'warn' : ''}`}>
                        <Icon size={15} />
                      </div>
                      <div>
                        <div className="t">{r.title}</div>
                        <div className="d">{r.detail}</div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '24px 0 10px' }}>
                <span className="label">Quants · click to override</span>
                {quantOverride && (
                  <button className="btn sm ghost" onClick={() => setQuantOverride(null)}>
                    <RotateCcw size={13} /> Planner pick
                  </button>
                )}
              </div>
              <table className="quant-table">
                <thead>
                  <tr>
                    <th>Quant</th>
                    <th className="r">Size</th>
                    <th className="r">Quality</th>
                    <th className="r">tok/s</th>
                    <th>Fit</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.options.map((o) => (
                    <tr key={o.quantId} className={`pick ${o.chosen ? 'chosen' : ''}`} onClick={() => setQuantOverride(o.quantId)}>
                      <td>
                        {o.chosen && <Check size={12} style={{ marginRight: 5, verticalAlign: -1 }} />}
                        {o.quantId}
                        {state?.downloaded.some((d) => d.modelId === modelId && d.quantId === o.quantId) && <span className="chip outline" style={{ marginLeft: 8, height: 20 }}>on disk</span>}
                      </td>
                      <td className="r">{bytes(o.sizeBytes)}</td>
                      <td className="r">{pct(o.qualityPct)}</td>
                      <td className="r">{o.fit === 'no-fit' ? '—' : tps(o.genTps)}</td>
                      <td>
                        <span className={o.fit === 'no-fit' ? 'faint' : o.fit === 'gpu' ? '' : 'muted'} style={{ fontFamily: 'var(--font-body)', fontSize: 12 }}>
                          {o.fit === 'gpu' ? 'GPU' : o.fit === 'partial' ? 'Split' : o.fit === 'cpu' ? 'CPU' : 'Too big'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="label" style={{ margin: '24px 0 10px' }}>
                Engine command
              </div>
              {data && <CopyBlock text={data.command} />}
            </>
          )}
        </div>

        {plan && !preview && (
          <div className="drawer-foot">
            {downloaded && !isRunning && (
              <button
                className="btn sm ghost danger"
                title="Delete this download"
                onClick={async () => {
                  if (!confirm(`Delete ${plan.modelName} ${quantId} from disk? You can download it again later.`)) return;
                  try {
                    await api(`/api/models/${modelId}/${quantId}`, { method: 'DELETE' });
                    refreshState();
                    notify(`Deleted ${plan.modelName} ${quantId}`);
                  } catch (e) {
                    notify((e as Error).message, true);
                  }
                }}
              >
                <Trash2 size={14} /> Delete
              </button>
            )}
            <div style={{ flex: 1 }} />
            {isRunning ? (
              <>
                <button className="btn" onClick={() => stopModel()}>
                  <Square size={14} /> Stop
                </button>
                <button className="btn primary" onClick={() => (onClose(), go('chat'))}>
                  <MessageSquare size={15} /> Open chat
                </button>
              </>
            ) : runJob?.status === 'running' ? (
              <button className="btn" onClick={() => api(`/api/jobs/${runJob.id}/cancel`, { method: 'POST', json: {} }).then(refreshState)}>
                <X size={14} /> Cancel
              </button>
            ) : plan.fit === 'no-fit' ? (
              plan.blockedBy === 'free-memory' ? (
                <>
                  <span className="muted" style={{ fontSize: 13 }}>
                    Needs {bytes(plan.memory.gpuBytes + plan.memory.ramBytes)}, {bytes(plan.memory.freeNowBytes)} free now
                  </span>
                  <button className="btn" onClick={() => setGoal({ ...goal, memory: 'total' })} title="Plan as if other apps were closed">
                    Plan for whole machine
                  </button>
                </>
              ) : (
                <span className="muted" style={{ fontSize: 13 }}>
                  Too big for this machine{quantOverride ? ' at this quant' : ''}
                </span>
              )
            ) : (
              <>
                <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, cursor: 'pointer' }} title="Skip the 30–90 second benchmark sweep">
                  <input type="checkbox" checked={skipTune} onChange={(e) => setSkipTune(e.target.checked)} /> Skip tuning
                </label>
                {data?.mlx.supported && data.mlx.variants.length > 0 && !skipTune && (
                  <label
                    className="muted"
                    style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, cursor: 'pointer' }}
                    title={`Benchmark Apple's MLX engine against llama.cpp. ${data.mlx.installed ? '' : 'Installs MLX (a few hundred MB) and '}downloads a matching MLX build of the model.`}
                  >
                    <input type="checkbox" checked={tryMlx} onChange={(e) => setTryMlx(e.target.checked)} /> Also try MLX
                  </label>
                )}
                {!downloaded &&
                  (dlJob ? (
                    <button className="btn" disabled>
                      <LoaderCircle size={14} className="spin" />
                      {dlJob.progress ? `${Math.round((dlJob.progress.received / dlJob.progress.total) * 100)}% · ${eta(dlJob.progress.received, dlJob.progress.total, dlJob.progress.speed)}` : 'Starting'}
                    </button>
                  ) : (
                    <button className="btn" onClick={() => pullModel(modelId, quantId!)}>
                      <Download size={14} /> Download {bytes(plan.memory.weightsBytes)}
                    </button>
                  ))}
                <button className="btn primary" onClick={() => runModel(modelId, { quantId: quantOverride ?? undefined, tune: !skipTune, tryMlx: tryMlx && !skipTune })} disabled={!!dlJob}>
                  <Play size={15} /> {skipTune ? 'Run' : 'Tune & run'}
                </button>
              </>
            )}
          </div>
        )}
      </aside>
    </>
  );
}

function Stat({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="label">{k}</div>
      <div className="v">
        {v}
        {sub && <small>{sub}</small>}
      </div>
    </div>
  );
}

const STEPS = [
  { id: 'engine', label: 'Engine' },
  { id: 'plan', label: 'Plan for this machine' },
  { id: 'download', label: 'Download weights' },
  { id: 'tune', label: 'Benchmark configurations' },
  { id: 'start', label: 'Load the winner' },
  { id: 'ready', label: 'Ready' },
];

function RunProgress({
  job,
  running,
  headline,
}: {
  job: Job;
  running: boolean;
  headline: {
    genTps: number;
    qualityPct: number;
    score: number;
    qualitySource: string;
    tuned: boolean;
    promptTps: number;
    workloads?: Partial<Record<'chat' | 'code' | 'edit', { genTps: number; spread: number }>>;
    bestPerWorkload?: Partial<Record<'chat' | 'code' | 'edit', string>>;
  } | null;
}) {
  const { go } = useApp();
  const current = running ? 'ready' : job.stage ?? 'engine';
  const idx = STEPS.findIndex((s) => s.id === current);
  const maxTps = useMemo(() => Math.max(1, ...job.trials.map((t) => t.genTps)), [job.trials]);
  const winner = useMemo(() => [...job.trials].filter((t) => t.ok).sort((a, b) => (b.score ?? b.genTps) - (a.score ?? a.genTps))[0], [job.trials]);
  const [showLog, setShowLog] = useState(false);
  const skippedTune = job.trials.length === 0 && idx > 3;

  return (
    <div style={{ marginBottom: 26 }}>
      {running && headline && (
        <div className="panel headline">
          <Readout
            size="lg"
            value={tps(headline.genTps)}
            unit={headline.tuned ? 'tokens per second' : 'tokens per second · est.'}
            source={headline.tuned ? 'Measured on your machine' : 'Predicted, not measured · tuning was skipped'}
          />
          <StatStrip
            stats={[
              { k: 'quality', v: `${pct(headline.qualityPct)}${headline.qualitySource === 'estimate' ? ' est.' : ''}` },
              { k: 'score', v: headline.score.toLocaleString() },
            ]}
          />
          {headline.workloads && (
            <div className="faint mono" style={{ fontSize: 12 }}>
              {(['chat', 'code', 'edit'] as const)
                .filter((k) => headline.workloads?.[k])
                .map((k) => `${k} ${tps(headline.workloads![k]!.genTps)}`)
                .join(' · ')}{' '}
              tok/s
            </div>
          )}
          {headline.bestPerWorkload && new Set(Object.values(headline.bestPerWorkload)).size > 1 && (
            <div className="faint" style={{ fontSize: 13 }}>
              Different setups won different jobs: {Object.entries(headline.bestPerWorkload).map(([k, v]) => `${k} → ${v}`).join(', ')}. The winner is picked for your workload.
            </div>
          )}
          <div>
            <button className="btn primary" onClick={() => go('chat')}>
              <MessageSquare size={15} /> Start chatting
            </button>
          </div>
        </div>
      )}

      {job.status === 'error' && (
        <div className="warn-box" style={{ flexDirection: 'column' }}>
          <div style={{ display: 'flex', gap: 8, fontWeight: 600 }}>
            <TriangleAlert size={16} /> Couldn’t start {job.title}
          </div>
          <div className="mono" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
            {job.error}
          </div>
        </div>
      )}

      {!running && (
        <div className="steps">
          {STEPS.map((s, i) => {
            const st = job.status === 'error' && i === idx ? 'active' : i < idx ? 'done' : i === idx ? 'active' : '';
            return (
              <div key={s.id} className={`step ${st}`}>
                <div className="step-dot">
                  {st === 'done' ? <Check size={12} /> : st === 'active' && job.status === 'running' ? <LoaderCircle size={12} className="spin" /> : <span style={{ fontSize: 10 }} className="mono">{i + 1}</span>}
                </div>
                <div>
                  {s.label}
                  {s.id === 'tune' && skippedTune ? <span className="faint"> · skipped</span> : null}
                  {st === 'active' && job.progress && (s.id === 'download' || s.id === 'engine') && (
                    <>
                      <div className="mini-progress" style={{ marginTop: 6 }}>
                        <div style={{ width: `${(job.progress.received / Math.max(1, job.progress.total)) * 100}%` }} />
                      </div>
                      <div className="faint mono" style={{ fontSize: 11, marginTop: 4 }}>
                        {bytes(job.progress.received)} / {bytes(job.progress.total)} · {bytes(job.progress.speed)}/s · {eta(job.progress.received, job.progress.total, job.progress.speed)}
                      </div>
                    </>
                  )}
                </div>
                <span className="faint mono" style={{ fontSize: 11 }}>
                  {s.id === 'tune' && job.trialRunning && st === 'active' ? `${job.trialRunning.index + 1}/${job.trialRunning.total}` : ''}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {(job.trials.length > 0 || job.trialRunning) && (
        <div className="panel" style={{ padding: '14px 18px', marginBottom: 14 }}>
          <div className="label" style={{ marginBottom: 8 }}>
            Tuning sweep
          </div>
          {job.trials.map((t) => (
            <div key={t.label} className={`trial ${winner?.label === t.label ? 'win' : ''}`}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: 14 }}>
                  {t.label} {winner?.label === t.label && <span style={{ fontWeight: 400 }}> · fastest</span>}
                </div>
                <div className="faint mono" style={{ fontSize: 11 }}>
                  {t.ok
                    ? [
                        t.workloads ? (['chat', 'code', 'edit'] as const).filter((k) => t.workloads?.[k]).map((k) => `${k} ${tps(t.workloads![k]!.genTps)}`).join(' · ') : null,
                        t.sampledTps ? `temp 0.7: ${tps(t.sampledTps)}` : null,
                        t.longPrompt ? `long prompt ${t.longPrompt.promptTps} tok/s` : null,
                        t.parallelTps ? `parallel ${tps(t.parallelTps)}` : null,
                        t.draftAcceptRate != null ? `${Math.round(t.draftAcceptRate * 100)}% drafts kept` : null,
                        t.pruned ? 'stopped early: clearly slower' : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    : 'failed to start'}
                </div>
              </div>
              <div className="trial-bar">
                <div style={{ width: `${t.ok ? (t.genTps / maxTps) * 100 : 0}%` }} />
              </div>
              <div className="mono" style={{ textAlign: 'right', color: t.ok ? 'var(--text)' : 'var(--oxide)' }}>
                {t.ok ? tps(t.genTps) : '✕'}
              </div>
            </div>
          ))}
          {job.trialRunning && (
            <div className="trial">
              <div style={{ fontWeight: 500, fontSize: 14 }}>{job.trialRunning.label}</div>
              <div className="mini-progress indeterminate" style={{ marginTop: 0, height: 8 }}>
                <div />
              </div>
              <div className="faint mono" style={{ textAlign: 'right' }}>
                …
              </div>
            </div>
          )}
        </div>
      )}

      {job.logs.length > 0 && (
        <>
          <button className="thinking-toggle" onClick={() => setShowLog(!showLog)}>
            {showLog ? '▾' : '▸'} Log ({job.logs.length} lines)
          </button>
          {showLog && (
            <div className="log" style={{ marginTop: 8 }}>
              {job.logs.join('\n')}
            </div>
          )}
        </>
      )}
      <div className="divider" />
    </div>
  );
}
