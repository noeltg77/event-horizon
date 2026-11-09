import { useEffect, useState } from 'react';
import { MoonStar, Play, Plug, Square, Terminal } from 'lucide-react';
import { api, bytes, tps, usePoll, type MonitorSample } from '../api';
import { CopyBlock, Horizon, Readout, Sparkline } from '../components';
import { useApp } from '../App';

const HISTORY = 90;

export function MonitorPage() {
  const { state, stopModel, go, refreshState, notify } = useApp();
  const { data } = usePoll<MonitorSample>('/api/monitor', 1000);
  const [hist, setHist] = useState<MonitorSample[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const { data: logs } = usePoll<{ lines: string[] }>(showLogs ? '/api/logs?n=300' : null, 2000);
  const session = state?.session;
  const ready = session?.state === 'ready';
  const parked = session?.state === 'parked' || session?.state === 'waking';
  const setKeepAlive = async (minutes: number) => {
    try {
      await api('/api/settings', { method: 'POST', json: { keepAliveMinutes: minutes } });
      refreshState();
    } catch (e) {
      notify((e as Error).message, true);
    }
  };

  useEffect(() => {
    if (data) setHist((h) => [...h.slice(-(HISTORY - 1)), data]);
  }, [data]);

  const live = data?.llama;
  const gen = live?.busy ? live.genTps : live?.genTps ?? null;
  const base = state?.apiBase ?? 'http://127.0.0.1:4747/v1';
  const modelId = session?.modelId ?? '<model>';

  return (
    <div className="page">
      <div className={`shell ${ready || parked ? 'hero' : 'page-head'}`}>
        {(ready || parked) && (
          <Readout
            value={tps(gen ?? session?.headline?.genTps)}
            unit={session?.headline?.tuned || gen != null ? 'tokens per second' : 'tokens per second · est.'}
            source={live?.busy ? 'Live · generating now' : gen != null ? 'Last reply · measured on your machine' : session?.headline?.tuned ? 'Measured when tuned' : 'Predicted'}
          />
        )}
        <div className={ready || parked ? 'hero-side' : undefined}>
          <div className="eyebrow">Live monitor</div>
          <h1>{ready || parked ? session?.modelName : 'Nothing running'}</h1>
          <p className="lede">
            {ready
              ? `llama.cpp ${session?.engine?.tag} · ${session?.config?.quantId} · ${Math.round((session?.config?.ctx ?? 0) / 1024)}K context · PID ${session?.pid}`
              : parked
                ? 'Unloaded after sitting idle, so it is using no memory or compute. It reloads with the same settings when you send a message.'
                : 'Start a model from the Models page to see live speed, memory and context use here.'}
          </p>
        {parked ? (
          <div className="hero-actions">
            <button className="btn" onClick={() => stopModel()}>
              <Square size={14} /> Forget
            </button>
            <button className="btn primary" onClick={() => api('/api/wake', { method: 'POST', json: {} }).then(refreshState).catch((e) => notify(e.message, true))} disabled={session?.state === 'waking'}>
              <Play size={14} /> Load now
            </button>
          </div>
        ) : ready ? (
          <div className="hero-actions">
            <button className="btn primary" onClick={() => go('chat')}>
              Start chatting
            </button>
            <button className="btn" onClick={() => stopModel()}>
              <Square size={14} /> Stop
            </button>
          </div>
        ) : null}
        </div>
        {!ready && !parked && (
          <button className="btn primary" onClick={() => go('models')}>
            Browse models
          </button>
        )}
      </div>

      <Horizon>
        <div className="grid-3" style={{ marginBottom: 20 }}>
          <div className="panel tile span-2">
            <div className="label">Generation</div>
            <div className="big" style={{ marginTop: 6 }}>
              {tps(gen)}
              <small>tok/s · {live?.busy ? 'live' : 'last reply'}</small>
            </div>
            <Sparkline values={hist.map((h) => h.llama?.genTps ?? null)} color="var(--ember)" />
            <div className="faint mono" style={{ fontSize: 12, marginTop: 8 }}>
              {session?.headline?.tuned ? 'measured' : 'predicted'} at {tps(session?.headline?.genTps)} tok/s when tuned
            </div>
          </div>
          <Tile label="Prompt processing" value={tps(live?.promptTps)} unit="tok/s" spark={hist.map((h) => h.llama?.promptTps ?? null)} color="var(--steel)" />
          <Tile
            label="System memory"
            value={data ? bytes(data.ram.usedBytes) : '—'}
            unit={data ? `of ${bytes(data.ram.totalBytes, 0)}` : ''}
            spark={hist.map((h) => h.ram.usedBytes)}
            max={data?.ram.totalBytes}
            color="var(--steel)"
          />
          <Tile
            label="Engine process"
            value={data?.engine?.rssBytes ? bytes(data.engine.rssBytes) : '—'}
            unit={data?.engine?.cpuPct != null ? `held · ${Math.round(data.engine.cpuPct)}% CPU${live?.busy ? '' : ' (idle)'}` : 'held in memory'}
            spark={hist.map((h) => h.engine?.rssBytes ?? null)}
          />
          {data?.gpu ? (
            <Tile label="VRAM" value={bytes(data.gpu.usedBytes)} unit={`of ${bytes(data.gpu.totalBytes, 0)} · ${data.gpu.util ?? 0}% busy`} spark={hist.map((h) => h.gpu?.usedBytes ?? null)} max={data.gpu.totalBytes} />
          ) : (
            <Tile
              label="Context in use"
              value={live?.ctxUsed != null ? live.ctxUsed.toLocaleString() : '—'}
              unit={live?.ctxSize ? `of ${live.ctxSize.toLocaleString()} tokens` : 'tokens'}
              spark={hist.map((h) => h.llama?.ctxUsed ?? null)}
              max={live?.ctxSize ?? undefined}
              color="var(--ink-soft)"
            />
          )}
        </div>

        <div className="grid-3" style={{ marginBottom: 20 }}>
          <Tile label="Tokens generated" value={live ? live.tokensPredicted.toLocaleString() : '—'} unit="this session" />
          <Tile label="Draft acceptance" value={live?.draftAccept != null ? `${Math.round(live.draftAccept * 100)}%` : '—'} unit={session?.config?.spec.type && session.config.spec.type !== 'none' ? session.config.spec.type : 'no speculative decoding'} />
          {data?.gpu ? (
            <Tile label="Context in use" value={live?.ctxUsed != null ? live.ctxUsed.toLocaleString() : '—'} unit={live?.ctxSize ? `of ${live.ctxSize.toLocaleString()}` : 'tokens'} />
          ) : (
            <Tile
              label="Expert cache"
              value={session?.config?.moeCacheMiB ? bytes(session.config.moeCacheMiB * 1048576) : '—'}
              unit={session?.config?.nCpuMoe ? `${session.config.nCpuMoe} expert layers in RAM` : 'not needed on this machine'}
            />
          )}
        </div>

        <div className="panel tile" style={{ marginBottom: 20 }}>
          <div className="tile-head">
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <MoonStar size={17} /> Memory when idle
            </h2>
            {ready && (
              <button className="btn sm" onClick={() => api('/api/park', { method: 'POST', json: {} }).then(refreshState)}>
                Unload now
              </button>
            )}
          </div>
          <p className="muted" style={{ marginTop: 0, fontSize: 13.5, maxWidth: '75ch' }}>
            Between replies the engine uses no CPU or GPU, but it keeps the model’s weights in memory so the next reply starts instantly. To give that memory back, Event Horizon unloads the model after it sits idle and reloads it, with the same tuned settings, when the next message or API request arrives. Reloading takes a few seconds.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span className="label">Unload after</span>
            <div className="seg">
              {[2, 5, 10, 30, 60, 0].map((m) => (
                <button key={m} className={(session?.keepAliveMinutes ?? 10) === m ? 'on' : ''} onClick={() => setKeepAlive(m)}>
                  {m === 0 ? 'Never' : m < 60 ? `${m} min` : '1 hour'}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="grid-2">
          <div className="panel tile">
            <div className="tile-head">
              <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Plug size={17} /> Connect your tools
              </h2>
            </div>
            <p className="muted" style={{ marginTop: 0, fontSize: 13.5 }}>
              Point any OpenAI-compatible app (Cursor, OpenCode, Continue, Open WebUI, scripts) at this base URL. It stays the same whichever model you run.
            </p>
            <CopyBlock text={`OPENAI_BASE_URL=${base}\nOPENAI_API_KEY=localmax\nmodel: ${modelId}`} />
            <div style={{ height: 10 }} />
            <CopyBlock text={`curl ${base}/chat/completions \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"${modelId}","messages":[{"role":"user","content":"Hello"}]}'`} />
          </div>
          <div className="panel tile">
            <div className="tile-head">
              <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Terminal size={17} /> Engine
              </h2>
              <button className="btn sm ghost" onClick={() => setShowLogs(!showLogs)}>
                {showLogs ? 'Hide log' : 'Show log'}
              </button>
            </div>
            {session?.command ? <CopyBlock text={session.command} /> : <p className="muted">The exact llama-server command appears here once a model is running.</p>}
            {showLogs && (
              <div className="log" style={{ marginTop: 10, maxHeight: 260 }}>
                {logs?.lines.join('\n') || 'No output yet.'}
              </div>
            )}
          </div>
        </div>
      </Horizon>
    </div>
  );
}

function Tile({ label, value, unit, spark, max, color }: { label: string; value: string; unit?: string; spark?: (number | null)[]; max?: number; color?: string }) {
  return (
    <div className="panel tile">
      <div className="label">{label}</div>
      <div className="big" style={{ marginTop: 6 }}>
        {value}
        {unit && <small>{unit}</small>}
      </div>
      {spark && <Sparkline values={spark} max={max} color={color} />}
    </div>
  );
}
