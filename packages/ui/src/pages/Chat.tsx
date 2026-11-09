import { useEffect, useRef, useState, type Dispatch, type SetStateAction, type ReactNode } from 'react';
import { ArrowUp, Brain, Eraser, Play, Settings2, Square } from 'lucide-react';
import { tps } from '../api';
import { useApp } from '../App';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  stats?: { tps: number; tokens: number; promptTps?: number; ms: number };
  error?: string;
}

export interface ChatState {
  messages: ChatMessage[];
  system: string;
  /** Let reasoning models think before answering (slower first token, better on hard problems) */
  think?: boolean;
}

const SUGGESTIONS = [
  'Explain how speculative decoding works, like I’m an engineer new to LLMs.',
  'Write a bash one-liner that finds the 10 largest files under my home folder.',
  'Draft a polite email asking a supplier for a revised delivery date.',
  'What are the trade-offs between 4-bit and 8-bit quantisation?',
];

export function ChatPage({ chat, setChat }: { chat: ChatState; setChat: Dispatch<SetStateAction<ChatState>> }) {
  const { state, go, runModel } = useApp();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [showSystem, setShowSystem] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const session = state?.session;
  // A parked model reloads automatically when a message is sent
  const ready = session?.state === 'ready' || session?.state === 'parked' || session?.state === 'waking';
  const parked = session?.state === 'parked' || session?.state === 'waking';

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: busy ? 'auto' : 'smooth' });
  }, [chat.messages, busy]);

  useEffect(() => {
    if (ready) ta.current?.focus();
  }, [ready]);

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || busy || !ready) return;
    setInput('');
    const history: ChatMessage[] = [...chat.messages, { role: 'user', content }];
    setChat((c) => ({ ...c, messages: [...history, { role: 'assistant', content: '' }] }));
    setBusy(true);
    const ac = new AbortController();
    abort.current = ac;
    const t0 = performance.now();
    let acc = '';
    let reasoning = '';
    let stats: ChatMessage['stats'];
    const update = (patch: Partial<ChatMessage>) =>
      setChat((c) => {
        const msgs = [...c.messages];
        msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], ...patch };
        return { ...c, messages: msgs };
      });
    try {
      const messages = [...(chat.system.trim() ? [{ role: 'system', content: chat.system.trim() }] : []), ...history.map((m) => ({ role: m.role, content: m.content }))];
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: session?.modelId,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          chat_template_kwargs: { enable_thinking: !!chat.think },
        }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error?.message ?? `Request failed (${res.status})`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            const d = j.choices?.[0]?.delta;
            if (d?.content) acc += d.content;
            if (d?.reasoning_content) reasoning += d.reasoning_content;
            if (j.timings) {
              stats = { tps: j.timings.predicted_per_second, tokens: j.timings.predicted_n, promptTps: j.timings.prompt_per_second, ms: performance.now() - t0 };
            }
          } catch {}
        }
        update({ content: acc, reasoning: reasoning || undefined });
      }
      update({ content: acc, reasoning: reasoning || undefined, stats });
    } catch (e) {
      if (ac.signal.aborted) update({ content: acc, reasoning: reasoning || undefined, stats });
      else update({ content: acc, error: (e as Error).message });
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  const lastDownloaded = state?.downloaded[0];

  return (
    <div className="chat">
      <div className="chat-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="eyebrow" style={{ marginBottom: 2 }}>
            Chat
          </div>
          {ready ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <h2>{session?.modelName}</h2>
              {parked ? (
                <span className="chip outline" title="Unloaded after sitting idle to free memory. It reloads when you send a message (a few seconds).">
                  {session?.state === 'waking' ? 'Reloading…' : 'Unloaded · reloads on send'}
                </span>
              ) : (
                <span className="chip mint">
                  <span className="dot pulse" />
                  {session?.config?.quantId}
                </span>
              )}
              {session?.headline && (
                <span className="chip">
                  <span className="mono">{tps(session.headline.genTps)} tok/s{session.headline.tuned ? '' : ' est.'}</span>
                </span>
              )}
            </div>
          ) : (
            <h2 className="muted">No model running</h2>
          )}
        </div>
        <button
          className={`btn sm ${chat.think ? '' : 'ghost'}`}
          onClick={() => setChat((c) => ({ ...c, think: !c.think }))}
          title="Let reasoning models think step by step before answering. Slower to start, better on hard problems."
          aria-pressed={!!chat.think}
        >
          <Brain size={14} /> Think {chat.think ? 'on' : 'off'}
        </button>
        <button className={`btn sm ${showSystem ? '' : 'ghost'}`} onClick={() => setShowSystem(!showSystem)} title="System prompt">
          <Settings2 size={14} /> System
        </button>
        <button className="btn sm ghost" onClick={() => setChat((c) => ({ ...c, messages: [] }))} disabled={busy || !chat.messages.length} title="New chat">
          <Eraser size={14} /> New chat
        </button>
      </div>

      <div className="chat-scroll" ref={scroller}>
        {showSystem && (
          <div className="panel" style={{ padding: 14 }}>
            <div className="label" style={{ marginBottom: 6 }}>
              System prompt
            </div>
            <textarea
              value={chat.system}
              onChange={(e) => setChat((c) => ({ ...c, system: e.target.value }))}
              placeholder="e.g. You are a concise assistant. Answer in British English."
              rows={3}
              style={{ width: '100%', background: 'none', border: 0, outline: 'none', resize: 'vertical' }}
            />
          </div>
        )}
        {!chat.messages.length ? (
          <div className="empty">
            {ready ? (
              <>
                <h2>What shall we ask {session?.modelName}?</h2>
                <p className="muted">Everything stays on this machine. Tokens per second show under each reply.</p>
                <div className="suggestions">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} className="suggestion" onClick={() => send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <h2>Start a model to chat</h2>
                <p className="muted">Pick a model that fits your machine. Event Horizon downloads it, tunes it and loads it for you.</p>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 18, flexWrap: 'wrap' }}>
                  {lastDownloaded && session?.state !== 'starting' && (
                    <button className="btn primary" onClick={() => runModel(lastDownloaded.modelId, { quantId: lastDownloaded.quantId })}>
                      <Play size={14} /> Run {lastDownloaded.modelId}
                    </button>
                  )}
                  <button className={`btn ${lastDownloaded ? '' : 'primary'}`} onClick={() => go('models')}>
                    Browse models
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          chat.messages.map((m, i) => <Message key={i} m={m} live={busy && i === chat.messages.length - 1} />)
        )}
      </div>

      <div className="composer">
        <div className="composer-box">
          <textarea
            ref={ta}
            rows={1}
            value={input}
            placeholder={ready ? 'Message the model…  (Enter to send, Shift+Enter for a new line)' : 'Start a model first'}
            disabled={!ready}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(200, e.target.scrollHeight)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
          />
          {busy ? (
            <button className="btn icon" onClick={() => abort.current?.abort()} title="Stop">
              <Square size={14} />
            </button>
          ) : (
            <button className="btn icon primary" onClick={() => send(input)} disabled={!ready || !input.trim()} title="Send">
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Message({ m, live }: { m: ChatMessage; live: boolean }) {
  const [open, setOpen] = useState(false);
  const thinkRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (live && thinkRef.current) thinkRef.current.scrollTop = thinkRef.current.scrollHeight;
  }, [m.reasoning, live]);
  if (m.role === 'user') {
    return (
      <div className="msg user">
        <div className="bubble">{m.content}</div>
      </div>
    );
  }
  const thinkingLive = live && !!m.reasoning && !m.content;
  return (
    <div className="msg assistant">
      {m.reasoning && (
        <div>
          <button className="thinking-toggle" onClick={() => setOpen(!open)}>
            {open || thinkingLive ? '▾' : '▸'} {thinkingLive ? `Thinking… ${m.reasoning.split(/\s+/).length.toLocaleString()} words` : `Thought for ${m.reasoning.split(/\s+/).length.toLocaleString()} words`}
          </button>
          {(open || thinkingLive) && (
            <div className="thinking" ref={thinkRef} style={{ marginTop: 6 }}>
              {m.reasoning}
            </div>
          )}
        </div>
      )}
      <div className="bubble">
        <Markdown text={m.content} />
        {live && !thinkingLive && <span className="caret" />}
        {live && !m.content && !m.reasoning && <span className="caret" />}
      </div>
      {m.error && <div className="warn-box" style={{ marginTop: 6 }}>{m.error}</div>}
      {m.stats && (
        <div className="msg-meta">
          <span className="tps">{tps(m.stats.tps)} tok/s</span>
          <span>{m.stats.tokens} tokens</span>
          {m.stats.promptTps ? <span>prompt {tps(m.stats.promptTps)} tok/s</span> : null}
          <span>{(m.stats.ms / 1000).toFixed(1)}s</span>
        </div>
      )}
    </div>
  );
}

/** Small, safe markdown renderer: code fences, inline code, bold/italic, lists, headings. No HTML injection. */
function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const parts = text.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const nl = part.indexOf('\n');
      const code = nl >= 0 ? part.slice(nl + 1) : part;
      blocks.push(
        <pre key={i}>
          <code>{code.replace(/\n$/, '')}</code>
        </pre>,
      );
      return;
    }
    const lines = part.split('\n');
    let list: { ordered: boolean; items: string[] } | null = null;
    let para: string[] = [];
    const flushPara = () => {
      if (para.length) blocks.push(<p key={`${i}-p${blocks.length}`}>{inline(para.join(' '))}</p>);
      para = [];
    };
    const flushList = () => {
      if (!list) return;
      const items = list.items.map((it, k) => <li key={k}>{inline(it)}</li>);
      blocks.push(list.ordered ? <ol key={`${i}-l${blocks.length}`}>{items}</ol> : <ul key={`${i}-l${blocks.length}`}>{items}</ul>);
      list = null;
    };
    for (const raw of lines) {
      const line = raw.trimEnd();
      const ul = line.match(/^\s*[-*•]\s+(.*)/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
      const h = line.match(/^#{1,4}\s+(.*)/);
      if (ul || ol) {
        flushPara();
        const ordered = !!ol;
        if (!list || list.ordered !== ordered) {
          flushList();
          list = { ordered, items: [] };
        }
        list.items.push((ul ?? ol)![1]);
      } else if (h) {
        flushPara();
        flushList();
        blocks.push(<h4 key={`${i}-h${blocks.length}`}>{inline(h[1])}</h4>);
      } else if (!line.trim()) {
        flushPara();
        flushList();
      } else {
        flushList();
        para.push(line);
      }
    }
    flushPara();
    flushList();
  });
  return <>{blocks}</>;
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('`')) out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else if (t.startsWith('**')) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else out.push(<em key={k++}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
