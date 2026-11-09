import { useEffect, useState, type ReactNode } from 'react';
import { Check, Copy, TriangleAlert, X } from 'lucide-react';
import { bytes, type Plan } from './api';

/** The measured number, its unit and where it came from. One `xl` per screen. */
export function Readout({ value, unit, source, size = 'xl' }: { value: string; unit: string; source: string; size?: 'xl' | 'lg' }) {
  return (
    <div className="readout">
      <div className="label">{source}</div>
      <div className={size === 'xl' ? 'readout-xl' : 'readout-lg'}>{value}</div>
      <div className="readout-unit">{unit}</div>
    </div>
  );
}

/** The glowing edge at the bottom of a page. Detail panels sit inside it, on the void. */
export function Horizon({ children }: { children: ReactNode }) {
  return (
    <div className="horizon">
      <div className="horizon-inner">{children}</div>
    </div>
  );
}

/** Facts joined in one mono line: `quality 97.4% · score 3,918`. */
export function StatStrip({ stats }: { stats: { k: string; v: ReactNode }[] }) {
  return (
    <div className="stat-strip">
      {stats.map((s) => (
        <span key={s.k}>
          <span className="k">{s.k} </span>
          {s.v}
        </span>
      ))}
    </div>
  );
}

/** Where the model lives: GPU and RAM bars against their budgets. */
export function FuelStrip({ plan, unified, compact }: { plan: Plan; unified: boolean; compact?: boolean }) {
  const m = plan.memory;
  if (unified) {
    const total = m.gpuBudgetBytes + m.ramBudgetBytes;
    const used = m.gpuBytes + m.ramBytes;
    return (
      <div className={`fuel ${compact ? 'compact' : ''}`}>
        <FuelLine tag="GPU" used={m.gpuBytes} budget={m.gpuBudgetBytes} kind="gpu" over={plan.fit === 'no-fit'} />
        {!compact || m.ramBytes > 0 ? <FuelLine tag="CPU" used={m.ramBytes} budget={Math.max(total - m.gpuBytes, 1)} kind="ram" over={plan.fit === 'no-fit'} /> : null}
        {!compact && <div className="faint mono" style={{ fontSize: 11 }}>{bytes(used)} of {bytes(total)} unified memory</div>}
      </div>
    );
  }
  return (
    <div className={`fuel ${compact ? 'compact' : ''}`}>
      {m.gpuBudgetBytes > 0 && <FuelLine tag="VRAM" used={m.gpuBytes} budget={m.gpuBudgetBytes} kind="gpu" over={plan.fit === 'no-fit'} />}
      <FuelLine tag="RAM" used={m.ramBytes} budget={m.ramBudgetBytes} kind="ram" over={plan.fit === 'no-fit' && m.ramBytes > m.ramBudgetBytes} />
    </div>
  );
}

function FuelLine({ tag, used, budget, kind, over }: { tag: string; used: number; budget: number; kind: 'gpu' | 'ram'; over?: boolean }) {
  const frac = budget > 0 ? Math.min(1, used / budget) : 0;
  return (
    <div className="fuel-line" title={`${tag}: ${bytes(used)} of ${bytes(budget)}`}>
      <span className="tag">{tag}</span>
      <div className="fuel-track">
        <div className={`fuel-fill ${over ? 'over' : kind}`} style={{ width: `${Math.max(used > 0 ? 3 : 0, frac * 100)}%` }} />
      </div>
    </div>
  );
}

export function Sparkline({ values, color = 'var(--ink-muted)', max }: { values: (number | null)[]; color?: string; max?: number }) {
  const w = 300;
  const h = 54;
  const nums = values.map((v) => v ?? 0);
  const top = max ?? Math.max(1, ...nums) * 1.15;
  const step = w / Math.max(1, values.length - 1);
  const pts = nums.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / top) * (h - 4) - 2).toFixed(1)}`);
  const path = pts.length ? `M ${pts.join(' L ')}` : '';
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      {path && <path d={`${path} L ${w},${h} L 0,${h} Z`} fill={color} opacity="0.1" />}
      {path && <path d={path} fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

export function FitChip({ fit, blockedBy }: { fit: Plan['fit']; blockedBy?: Plan['blockedBy'] }) {
  if (fit === 'no-fit' && blockedBy === 'free-memory') {
    return (
      <span className="chip brass" title="Fits this machine, but not in the memory free right now">
        <span className="dot" />
        Close apps first
      </span>
    );
  }
  const map = {
    gpu: ['mint', 'Fits on GPU'],
    partial: ['brass', 'Split GPU + RAM'],
    cpu: ['steel', 'CPU only'],
    'no-fit': ['oxide', 'Too big'],
  } as const;
  const [cls, text] = map[fit];
  return (
    <span className={`chip ${cls}`}>
      <span className="dot" />
      {text}
    </span>
  );
}

export function CopyBlock({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="code">
      {text}
      <button
        className="btn sm icon ghost copy-btn"
        title="Copy"
        onClick={() => {
          navigator.clipboard.writeText(text).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1400);
          });
        }}
      >
        {done ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)} title={o.title} role="tab" aria-selected={o.value === value}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toast({ message, error, onClose }: { message: string; error?: boolean; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, error ? 7000 : 3500);
    return () => clearTimeout(t);
  }, [message, error, onClose]);
  return (
    <div className={`toast ${error ? 'err' : ''}`} role="status">
      {error && <TriangleAlert size={16} />}
      <span>{message}</span>
      <button className="btn sm icon ghost" onClick={onClose} aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  );
}
