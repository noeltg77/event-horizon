import { Fragment, useState } from 'react';
import { History } from 'lucide-react';
import { pct, tps, usePoll, type BenchmarkRecord } from '../api';
import { useApp } from '../App';
import { Horizon } from '../components';

export function RunsPage() {
  const { go } = useApp();
  const { data } = usePoll<BenchmarkRecord[]>('/api/benchmarks', 5000);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="page">
      <div className="shell page-head">
        <div>
          <div className="eyebrow">Benchmarks</div>
          <h1>Tuning runs</h1>
          <p className="lede">Every tune-and-run sweep is logged as JSON in ~/.localmax/benchmarks, with the prediction next to what was measured. This is the dataset future planner versions learn from.</p>
        </div>
      </div>

      <Horizon>
        {!data?.length ? (
          <div className="panel empty" style={{ maxWidth: 'none', padding: 50 }}>
            <History size={28} className="faint" />
            <h2>No runs yet</h2>
            <p className="muted">Press “Tune & run” on any model and the sweep results land here.</p>
            <button className="btn primary" onClick={() => go('models')} style={{ marginTop: 10 }}>
              Browse models
            </button>
          </div>
        ) : (
          <div className="panel" style={{ overflow: 'hidden' }}>
            <table className="runs-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Model</th>
                  <th>Winner</th>
                  <th style={{ textAlign: 'right' }}>Predicted</th>
                  <th style={{ textAlign: 'right' }}>Measured</th>
                  <th style={{ textAlign: 'right' }}>Quality</th>
                  <th style={{ textAlign: 'right' }}>Score</th>
                </tr>
              </thead>
              <tbody>
                {data.map((b) => {
                  const w = b.winner;
                  const delta = w ? (w.genTps / Math.max(0.1, b.predicted.genTps) - 1) * 100 : 0;
                  return (
                    <Fragment key={b.id}>
                      <tr onClick={() => setOpen(open === b.id ? null : b.id)} style={{ cursor: 'pointer' }}>
                        <td className="muted">{new Date(b.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</td>
                        <td>
                          <strong>{b.model.id}</strong>
                          <div className="faint mono" style={{ fontSize: 11.5 }}>
                            {b.model.quantId} · {b.goal.mode}
                          </div>
                        </td>
                        <td>{w?.label ?? <span style={{ color: 'var(--oxide)' }}>all failed</span>}</td>
                        <td className="num muted">{tps(b.predicted.genTps)}</td>
                        <td className="num">
                          <span>{tps(w?.genTps)}</span>
                          {w && (
                            <div className="faint" style={{ fontSize: 11 }}>
                              {delta >= 0 ? '+' : ''}
                              {delta.toFixed(0)}% vs plan
                            </div>
                          )}
                        </td>
                        <td className="num">{w ? pct(w.qualityPct) : '—'}</td>
                        <td className="num">{w?.score.toLocaleString() ?? '—'}</td>
                      </tr>
                      {open === b.id && (
                        <tr>
                          <td colSpan={7} style={{ background: 'var(--bg-raise)' }}>
                            <div className="faint mono" style={{ fontSize: 11.5, marginBottom: 8 }}>
                              {b.hardware.cpu} · {b.hardware.gpus.join(', ') || 'no GPU'} · {b.hardware.ramGB} GB · llama.cpp {b.engine.tag} · {(b.durationMs / 1000).toFixed(0)}s sweep
                            </div>
                            {b.trials.map((t) => (
                              <div key={t.label} style={{ display: 'flex', gap: 16, fontSize: 13, padding: '4px 0' }}>
                                <span style={{ width: 220 }}>{t.label}</span>
                                <span className="mono" style={{ width: 90, color: t.ok ? 'var(--text)' : 'var(--oxide)' }}>
                                  {t.ok ? `${tps(t.genTps)} tok/s` : 'failed'}
                                </span>
                                <span className="mono faint">
                                  {t.ok ? `prompt ${t.promptTps} tok/s · load ${(t.loadMs / 1000).toFixed(1)}s` : t.error?.split('\n')[0]}
                                </span>
                              </div>
                            ))}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Horizon>
    </div>
  );
}
