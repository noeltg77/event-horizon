# Event Horizon: Style Guide

Version 1 · built from the **1c Horizon Line** mockup · dark theme only

Event Horizon runs open AI models on your own machine, tuned for the most tokens per second without losing quality. The look is built on one idea: **the screen is the view just above a black hole.** Everything you need to read sits in warm darkness above the edge, and the private stuff (your model, your data) sits inside the horizon, where nothing escapes.

> Measured numbers, warm darkness, one glowing edge.

---

## 1. Content rules

- **Lead with the measured number.** The biggest thing on a screen is a real measurement (tok/s), never a marketing claim. Say where it came from: "Measured on your machine".
- **Plain words, light space flavour.** The theme lives in the visuals and a few phrases. Good: "Nothing crosses the horizon." Avoid: "Initiating warp sequence".
- **Short labels, sentence-case copy.** Panel labels are short uppercase mono (`TUNING SWEEP`). Buttons and body copy are sentence case.
- **Honest about estimates.** If a number is estimated, put "est." next to it. Never call a tie a win.
- **No em dashes.** Join short facts with a middle dot: `3.6 of 15.6 GB · all on GPU`.

---

## 2. Colour

| Token | Hex | Use |
| --- | --- | --- |
| `ground` | `#0C0806` | Page background above the horizon. Warm black, never pure black. |
| `void` | `#000000` | Inside the horizon: the disc at the bottom and anything on it. Horizon motif only. |
| `surface` | `#0E0A08` | Panel background, on the void. |
| `surface-raised` | `#2A1A10` | Selected state of quiet controls (active nav pill). |
| `track` | `#241912` | Empty part of meters and progress bars. |
| `line` | `#2A1E16` | 1px panel borders. Borders, not shadows, separate things. |
| `line-strong` | `#4A3526` | Secondary button and input borders. |
| `ink` | `#FBEFE3` | Primary text and big readouts. |
| `ink-soft` | `#D9CABD` | Body copy and descriptions. |
| `ink-muted` | `#B8A595` | Mono labels, units, inactive nav. Passes 4.5:1 on `ground` and `surface`. |
| `ember` | `#FF8A3D` | **The one accent.** Primary button, hero unit, winning row, kickers. One or two places per screen. |
| `ember-hot` | `#FFB347` | Glow core of the horizon edge. Decorative only, never text. |
| `ember-pale` | `#FFD9A8` | 2px photon line on the horizon edge; focus rings. Decorative only. |
| `on-ember` | `#1A0A02` | Text on ember buttons. |

---

## 3. Typography

| Style | Family | Size / line height | Weight | Tracking | Use |
| --- | --- | --- | --- | --- | --- |
| `readout-xl` | Space Grotesk | 190px / 0.9 | 700 | -0.05em | Hero tok/s. One per screen. |
| `title` | Space Grotesk | 50px / 1 | 700 | | Model or page title |
| `readout-unit` | Space Grotesk | 20px / 1.3 | 500 | | Unit under the hero number, in `ember` |
| `body-lg` | Space Grotesk | 17px / 1.5 | 400 | | Descriptions |
| `body` | Space Grotesk | 15px / 1.5 | 400 | | Panel rows, general UI |
| `button` | Space Grotesk | 16px / 1.2 | 700 (secondary 400) | | Buttons |
| `nav` | Space Grotesk | 14px / 1.2 | 400 | | Nav pills |
| `label` | JetBrains Mono | 12px / 1.4 | 400 | 0.16em | Panel labels, uppercase |
| `kicker` | JetBrains Mono | 13px / 1.4 | 400 | 0.16em | Line above a title, in `ember` |
| `data` | JetBrains Mono | 14px / 1.4 | 400 | | Numbers in rows and stat strips |

Load the fonts:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
```

---

## 4. Spacing, radius, shadow

| Token | Value | Use |
| --- | --- | --- |
| `space-2` | 8px | Tight gaps inside a stat |
| `space-3` | 12px | Between panel rows; between buttons |
| `space-5` | 20px | Between panels |
| `space-panel` | 22px | Panel padding |
| `space-6` | 24px | Top page padding |
| `space-8` | 32px | Side page padding; gap between hero columns |
| `space-horizon` | 70px | Hero to horizon edge, and edge to first panel |
| `radius-meter` | 5px | Meters |
| `radius-panel` | 20px | Panels |
| `radius-pill` | 999px | Buttons, nav |
| `shadow-horizon` | see below | The horizon edge. **The only shadow in the system.** |

---

## 5. Design tokens as code

### CSS custom properties (`tokens.css`)

```css
:root {
  /* Colour */
  --ground: #0C0806;
  --void: #000000;
  --surface: #0E0A08;
  --surface-raised: #2A1A10;
  --track: #241912;
  --line: #2A1E16;
  --line-strong: #4A3526;
  --ink: #FBEFE3;
  --ink-soft: #D9CABD;
  --ink-muted: #B8A595;
  --ember: #FF8A3D;
  --ember-hot: #FFB347;
  --ember-pale: #FFD9A8;
  --on-ember: #1A0A02;

  /* Type */
  --font-sans: "Space Grotesk", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;

  /* Spacing */
  --space-2: 8px;
  --space-3: 12px;
  --space-5: 20px;
  --space-panel: 22px;
  --space-6: 24px;
  --space-8: 32px;
  --space-horizon: 70px;

  /* Radius */
  --radius-meter: 5px;
  --radius-panel: 20px;
  --radius-pill: 999px;

  /* The one shadow */
  --shadow-horizon:
    0 0 0 2px #FFD9A8,
    0 -6px 30px 4px rgba(255, 179, 71, 0.65),
    0 -30px 140px 30px rgba(255, 106, 43, 0.35);
}

body {
  margin: 0;
  background: var(--ground);
  color: var(--ink);
  font-family: var(--font-sans);
}
```

### Type classes

```css
.readout-xl   { font: 700 190px/0.9 var(--font-sans); letter-spacing: -0.05em; }
.title        { font: 700 50px/1 var(--font-sans); }
.readout-unit { font: 500 20px/1.3 var(--font-sans); color: var(--ember); }
.body-lg      { font: 400 17px/1.5 var(--font-sans); color: var(--ink-soft); }
.body         { font: 400 15px/1.5 var(--font-sans); }
.label        { font: 400 12px/1.4 var(--font-mono); letter-spacing: 0.16em; text-transform: uppercase; color: var(--ink-muted); }
.kicker       { font: 400 13px/1.4 var(--font-mono); letter-spacing: 0.16em; text-transform: uppercase; color: var(--ember); }
.data         { font: 400 14px/1.4 var(--font-mono); }
```

### Tailwind (optional)

```js
// tailwind.config.js
export default {
  theme: {
    extend: {
      colors: {
        ground: '#0C0806',
        void: '#000000',
        surface: { DEFAULT: '#0E0A08', raised: '#2A1A10' },
        track: '#241912',
        line: { DEFAULT: '#2A1E16', strong: '#4A3526' },
        ink: { DEFAULT: '#FBEFE3', soft: '#D9CABD', muted: '#B8A595' },
        ember: { DEFAULT: '#FF8A3D', hot: '#FFB347', pale: '#FFD9A8', on: '#1A0A02' },
      },
      fontFamily: {
        sans: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: { meter: '5px', panel: '20px', pill: '999px' },
      boxShadow: {
        horizon: '0 0 0 2px #FFD9A8, 0 -6px 30px 4px rgba(255,179,71,0.65), 0 -30px 140px 30px rgba(255,106,43,0.35)',
      },
    },
  },
};
```

---

## 6. Page layout

```
┌──────────────────────────────────────────────────────────┐
│ EVENT HORIZON      (Models) Chat Monitor …    M3 Pro 18GB │  header
│                                                          │
│ MEASURED ON YOUR MACHINE          QWEN · DENSE 4.2B       │
│ 41.3                              Qwen3.5 4B              │  hero
│ tokens per second                 description, stats, CTA │
│                                                          │
│            ╭──────── glowing horizon edge ───────╮        │
│        ┌──────────┐ ┌──────────┐ ┌──────────┐            │  horizon
│        │  panel   │ │  panel   │ │  panel   │            │  (void)
└──────────────────────────────────────────────────────────┘
```

1. **Header:** wordmark left, pill nav, machine chip right.
2. **Hero:** giant readout left; kicker, title, description, stat strip and buttons right, aligned to the readout's baseline.
3. **Horizon:** a huge `void` disc rising from the bottom, `space-horizon` below the hero. Detail panels sit inside it.

```css
.page   { min-height: 100vh; overflow: hidden; }
.shell  { max-width: 1216px; margin: 0 auto; padding: var(--space-6) var(--space-8) 0; }
.header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; }
.hero   { display: flex; flex-wrap: wrap; gap: var(--space-8); align-items: flex-end; justify-content: space-between; margin-top: 30px; }
.hero-side { flex: 0 1 440px; min-width: 0; display: flex; flex-direction: column; gap: 14px; }
```

---

## 7. Components

### 7.1 Buttons and nav pills

One ember primary per screen. Secondary is outlined. Nav pills are quiet; the active one gets `surface-raised`.

```css
.btn {
  border-radius: var(--radius-pill);
  font: 700 16px/1.2 var(--font-sans);
  padding: 15px 28px;
  cursor: pointer;
}
.btn-primary   { background: var(--ember); color: var(--on-ember); border: 0; }
.btn-secondary { background: transparent; color: var(--ink); border: 1px solid var(--line-strong); font-weight: 400; padding: 15px 22px; }

.nav-pill {
  background: transparent; color: var(--ink-muted); border: 0;
  border-radius: var(--radius-pill); padding: 10px 18px;
  font: 400 14px/1.2 var(--font-sans);
}
.nav-pill[aria-current="page"] { background: var(--surface-raised); color: var(--ink); }

.btn:focus-visible, .nav-pill:focus-visible {
  outline: 2px solid var(--ember-pale);
  outline-offset: 2px;
}
```

```tsx
export function Button({ variant = 'primary', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' }) {
  return <button className={`btn btn-${variant}`} {...props} />;
}

export function Nav({ current }: { current: string }) {
  const items = ['Models', 'Chat', 'Monitor', 'Compare', 'Machine'];
  return (
    <nav aria-label="Main" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {items.map((i) => (
        <a key={i} href={`#/${i.toLowerCase()}`} className="nav-pill" aria-current={i === current ? 'page' : undefined}>{i}</a>
      ))}
    </nav>
  );
}
```

### 7.2 Hero readout

The measured number, its unit and where it came from. One per screen.

```tsx
export function Readout({ value, unit, source, stats }: {
  value: string; unit: string; source: string;
  stats?: { key: string; value: string }[];
}) {
  return (
    <div>
      <div className="label">{source}</div>
      <div className="readout-xl">{value}</div>
      <div className="readout-unit">{unit}</div>
      {stats && (
        <div className="data" style={{ display: 'flex', flexWrap: 'wrap', gap: 22, marginTop: 20 }}>
          {stats.map((s) => (
            <span key={s.key}><span style={{ color: 'var(--ink-muted)' }}>{s.key} </span>{s.value}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// <Readout value="41.3" unit="tokens per second" source="Measured on your machine"
//   stats={[{ key: 'quality', value: '97.4%' }, { key: 'score', value: '3,918' }]} />
```

### 7.3 Panel

Detail panels that live inside the horizon. Mono label, rows with mono values, optional meter. The winning row is the only ember thing in a panel.

```css
.panel-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: var(--space-5); }
.panel {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  padding: var(--space-panel);
  display: flex; flex-direction: column; gap: var(--space-3);
}
.panel-row       { display: flex; justify-content: space-between; font: 400 15px/1.5 var(--font-sans); }
.panel-row .n    { font-family: var(--font-mono); }
.panel-row.win   { color: var(--ember); }
.meter           { height: 10px; background: var(--track); border-radius: var(--radius-meter); overflow: hidden; }
.meter > span    { display: block; height: 100%; background: var(--ember); }
```

```tsx
export function Panel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="label">{label}</div>
      {children}
    </section>
  );
}

export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  return (
    <div className="meter" role="meter" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label}>
      <span style={{ width: `${(value / max) * 100}%` }} />
    </div>
  );
}

// <Panel label="Tuning sweep">
//   <div className="panel-row"><span>Planner pick</span><span className="n">34.0</span></div>
//   <div className="panel-row win"><span>N-gram lookahead · fastest</span><span className="n">41.3</span></div>
// </Panel>
```

### 7.4 Horizon (signature element)

A huge black disc rising from the bottom of the screen with a glowing edge. One per screen, always at the bottom. It should read as an edge, never as a visible ball.

```css
.horizon {
  position: relative;
  margin-top: var(--space-horizon);
  padding: var(--space-horizon) var(--space-8) 48px;
}
.horizon::before {
  content: "";
  position: absolute;
  left: 50%;
  top: 0;
  width: 3200px;
  height: 3200px;
  margin-left: -1600px;
  border-radius: 50%;
  background: var(--void);
  box-shadow: var(--shadow-horizon);
  pointer-events: none;
}
.horizon > * { position: relative; max-width: 1216px; margin: 0 auto; }
```

```tsx
export function Horizon({ children }: { children: React.ReactNode }) {
  return (
    <div className="horizon">
      <div className="panel-grid">{children}</div>
    </div>
  );
}
```

---

## 8. Full page example

```tsx
export function ModelPage() {
  return (
    <div className="page">
      <div className="shell">
        <header className="header">
          <span style={{ fontWeight: 700, letterSpacing: '0.22em', fontSize: 15 }}>EVENT HORIZON</span>
          <Nav current="Models" />
          <span className="data" style={{ color: 'var(--ink-muted)' }}>M3 Pro · 18 GB</span>
        </header>

        <section className="hero">
          <Readout value="41.3" unit="tokens per second" source="Measured on your machine" />
          <div className="hero-side">
            <div className="kicker">Qwen · dense 4.2B</div>
            <h1 className="title" style={{ margin: 0 }}>Qwen3.5 4B</h1>
            <p className="body-lg" style={{ margin: 0 }}>Surprisingly capable for its size. Fast on laptops with 8 GB or more.</p>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <Button>Start chatting</Button>
              <Button variant="secondary">Stop</Button>
            </div>
          </div>
        </section>
      </div>

      <Horizon>
        <Panel label="Tuning sweep">…</Panel>
        <Panel label="Where it lives">
          <Meter value={3.6} max={15.6} label="Memory used" />
          <div className="panel-row"><span>3.6 of 15.6 GB · all on GPU</span></div>
        </Panel>
        <Panel label="Why this setup">…</Panel>
      </Horizon>
    </div>
  );
}
```

---

## 9. Do and don't

| Do | Don't |
| --- | --- |
| One `readout-xl` per screen | Two giant numbers fighting |
| `ember` on one or two elements | Ember borders or ember panel backgrounds |
| Panels inside the horizon, on `void` | Panels floating above the edge |
| Uppercase mono labels in `ink-muted` | Mono for body copy |
| `shadow-horizon` once, on the edge | Glows on cards or buttons |
| Middle dots to join facts | Em dashes |
| "est." next to estimated numbers | Rounding a tie into a win |

---

## 10. Accessibility

- All text colours pass 4.5:1 on `ground` and `surface`. `ember` is fine for text and large numbers; `ember-hot` and `ember-pale` are never text.
- Focus ring: 2px `ember-pale`, 2px offset, on every interactive element.
- Use real `<button>`, `<a>` and `<input>` with `<label>`. Icon-only buttons need `aria-label`.
- Meters use `role="meter"` with value attributes.
- The horizon disc is decorative: keep it in CSS (`::before`) so screen readers skip it.

---

## 11. Not done yet

- **Logo:** none yet. Use the wordmark: EVENT HORIZON, Space Grotesk 700, 15px, 0.22em tracking, `ink`.
- **Icons:** no set yet. Use simple inline stroke SVGs at 1.5px in `ink-muted`. No emoji.
- **Light theme:** not designed.
- **Motion:** not designed. When it is, it should feel like gravity: slow ease-in, things drifting towards the horizon, no bounces.
