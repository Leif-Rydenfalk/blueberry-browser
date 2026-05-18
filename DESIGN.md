# Blueberry Browser — Design System

> Minimal. Purposeful. Blueberry-blue.

---

## 1. Brand

| Element | Value |
|---------|-------|
| Logo | 🫐 (blueberry emoji, no substitutes) |
| App name | Blueberry Browser |
| AI name | Blueberry AI |
| Loading indicator | 🫐 with `animate-pulse` |
| Empty states | Large 🫐 (`text-4xl` or bigger) + short copy |
| **Forbidden icons** | Sparkles ✨, stars ⭐, magic wands, robots 🤖, brains 🧠 |

The 🫐 is the identity. Use it consistently and sparingly — it lands harder when it isn't everywhere.

---

## 2. Color System

Always use CSS variables. Never hardcode a color value.

```css
/* Light mode */
--background: 255 255 255;       /* Pure white */
--foreground: 10 10 10;          /* Near-black */
--card: 250 250 250;             /* Neutral 50 */
--primary: 79 70 229;            /* Indigo-600 — blueberry */
--primary-foreground: 255 255 255;
--secondary: 245 245 245;        /* Neutral 100 */
--secondary-foreground: 64 64 64;
--muted: 245 245 245;
--muted-foreground: 115 115 115; /* Neutral 500 */
--accent: 238 240 255;           /* Soft indigo tint */
--accent-foreground: 55 48 163;  /* Indigo 800 */
--border: 229 229 229;           /* Neutral 200 */
--input: 229 229 229;
--ring: 79 70 229;

/* Dark mode */
--background: 10 10 10;          /* Near-black */
--foreground: 245 245 245;       /* Neutral 100 */
--card: 18 18 18;
--primary: 129 140 248;          /* Indigo-400 */
--primary-foreground: 255 255 255;
--secondary: 26 26 26;
--secondary-foreground: 212 212 212;
--muted: 26 26 26;
--muted-foreground: 163 163 163; /* Neutral 400 */
--accent: 30 27 75;
--accent-foreground: 199 210 254; /* Indigo 200 */
--border: 38 38 38;              /* Neutral 800 */
--input: 38 38 38;
--ring: 129 140 248;
```

### Semantic color usage

| Use case | Token |
|----------|-------|
| Primary action, links, active state | `text-primary`, `bg-primary` |
| Backgrounds | `bg-background` |
| Card / panel surfaces | `bg-background/60`, `bg-secondary/30` |
| Body text | `text-foreground` |
| Captions, metadata, placeholders | `text-muted-foreground` |
| Dividers | `border-border/50`, `border-border/60` |
| Destructive (delete, error) | `text-red-500`, `bg-red-500/10` |
| Recording / live status | `text-red-500`, `bg-red-500/5` |
| Success | `text-green-500` |

### Opacity modifiers

Use opacity modifiers (`/10`, `/20`, `/50`) over fixed hex values to keep surfaces adaptive to dark mode. Example: `bg-primary/10` instead of `bg-[#3b5bdb1a]`.

---

## 3. Glassmorphism

Apply to overlays, panels docked to window chrome, and floating surfaces. Do not apply to simple cards in a list.

```css
.glass {
  background: rgba(255, 255, 255, 0.85);
  backdrop-filter: blur(20px) saturate(1.4);
  -webkit-backdrop-filter: blur(20px) saturate(1.4);
  border-bottom: 1px solid rgba(229, 229, 229, 0.7);
}
.dark .glass {
  background: rgba(10, 10, 10, 0.85);
  border-bottom: 1px solid rgba(38, 38, 38, 0.8);
}
```

In Tailwind: `backdrop-blur-xl backdrop-saturate-150 bg-background/70`.

---

## 4. Spacing & Shape

**Base unit:** 4px (Tailwind default). All spacing is a multiple of 4.

### Border radius scale

| Context | Class | px |
|---------|-------|----|
| Pills, tags, badges | `rounded-full` | — |
| Inputs, text areas | `rounded-xl` | 12 |
| Cards, panels, list items | `rounded-2xl` | 16 |
| Buttons (primary) | `rounded-xl` | 12 |
| Buttons (ghost/icon) | `rounded-lg` | 8 |
| Small chips (model selector) | `rounded-md` | 6 |

Err on the side of more rounded. Flat corners feel out of place.

### Shadows

| Level | Class |
|-------|-------|
| Subtle (hover lift) | `shadow-[0_1px_3px_rgba(0,0,0,0.04)]` |
| Card | `shadow-sm` |
| Elevated modal / popover | `shadow-lg` |

---

## 5. Typography

No custom fonts — the system font stack is intentional.

| Use | Class |
|-----|-------|
| Section heading | `text-sm font-semibold` |
| Body / message text | `text-sm` |
| Metadata, timestamps, captions | `text-xs text-muted-foreground` |
| Code inline | `font-mono text-xs bg-secondary px-1.5 py-0.5 rounded-md` |

Keep copy short. Sidebar real estate is tight.

---

## 6. Interactive Elements

Every interactive element needs:
- `cursor-pointer`
- `app-region-no-drag` (where drag regions overlap)
- A visible focus state (use `focus:border-primary/40 focus:ring-1 focus:ring-primary/20`)
- A hover transition: `transition-colors` or `transition-all` at `150ms`

```tsx
// Standard ghost button pattern
className={cn(
  "flex items-center gap-1.5 px-3 py-1.5",
  "rounded-xl text-xs font-medium",
  "hover:bg-muted text-muted-foreground hover:text-foreground",
  "transition-colors cursor-pointer"
)}
```

```tsx
// Primary action button
className={cn(
  "flex items-center gap-1.5 px-3 py-2",
  "rounded-xl text-xs font-medium",
  "bg-primary text-primary-foreground",
  "hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed",
  "transition-opacity"
)}
```

```tsx
// Destructive / warning tint (e.g. recording, delete)
className={cn(
  "flex items-center gap-1.5 px-3 py-1.5",
  "rounded-xl text-xs font-medium",
  "bg-red-500/10 text-red-500 hover:bg-red-500/20",
  "border border-red-500/20 transition-colors"
)}
```

---

## 7. Status Indicators

| State | Visual |
|-------|--------|
| Loading / thinking | `🫐 animate-pulse` or `Loader2 animate-spin text-primary` |
| Live / recording | `size-2 rounded-full bg-red-500 animate-pulse` |
| Agent working | Pulsing dot `● text-primary animate-pulse` |
| Step success | `CheckCircle2 text-green-500` |
| Step error | `XCircle text-red-500` |
| Step running | `Loader2 text-primary animate-spin` |
| Step pending | Hollow dot `border-2 border-muted-foreground/30` |

---

## 8. Panel Layout Patterns

### Sidebar panel structure

Every sidebar panel follows this skeleton:

```
┌─ Header (px-4 py-3, border-b) ──────────────────────────────┐
│  Icon + title                     [action buttons]           │
├─ Sub-bar (optional, px-4 py-1.5) ───────────────────────────┤
│  Progress bar, recording state, model selector               │
├─ Scrollable content (flex-1 overflow-y-auto px-3 py-3) ─────┤
│  Cards / messages / list items                               │
└─ Footer input (p-3, border-t) ──────────────────────────────┘
```

### Card pattern (workflow / result cards)

```tsx
<div className={cn(
  "group rounded-xl border border-border/50",
  "hover:border-border transition-all p-3.5 space-y-2.5"
)}>
```

No default background fill — cards sit on `bg-background` naturally. No `rounded-2xl` on cards; `rounded-xl` (12 px) keeps the look tight.

### Inline input pattern (annotation, rename)

```tsx
<input className={cn(
  "text-xs rounded-lg bg-background",
  "border border-border/50 px-2 py-1.5",
  "outline-none focus:border-primary/40"
)} />
```

### Bottom sheet / modal

Used for confirmations and run-workflow goal override. Slides up from the bottom of the sidebar panel:

```
┌──────────────────────────────┐
│  backdrop (bg-black/40       │
│  backdrop-blur-sm)           │
│  ┌────────────────────────┐  │
│  │ rounded-2xl bg-        │  │
│  │ background border p-4  │  │
│  │ space-y-3              │  │
│  └────────────────────────┘  │
└──────────────────────────────┘
```

---

## 9. Tab Switcher

The sidebar top-level tab switcher (Agent | Workflows):

```tsx
<div className="flex border-b border-border/50">
  <button className={cn(
    "flex-1 py-2.5 text-xs font-medium transition-colors",
    "border-b-2 -mb-px",
    isActive
      ? "text-foreground border-primary"
      : "text-muted-foreground border-transparent hover:text-foreground"
  )}>
    Tab label
  </button>
</div>
```

Active state: underline `border-primary` — no filled pill, just a 2px bottom border flush with the container border.

---

## 10. Markdown Rendering

Agent replies render as markdown using `prose-sm dark:prose-invert`. Key overrides:

```tsx
className="prose prose-sm dark:prose-invert max-w-none
  prose-headings:text-foreground prose-p:text-foreground
  prose-strong:text-foreground
  prose-a:text-primary hover:prose-a:underline
  prose-code:bg-secondary prose-code:px-1.5 prose-code:py-0.5
  prose-code:rounded-md prose-code:text-xs prose-code:font-mono
  prose-pre:bg-secondary dark:prose-pre:bg-secondary/50
  prose-pre:p-3 prose-pre:rounded-xl prose-pre:text-xs"
```

---

## 11. Platform Awareness

**Never use `process.platform` in renderer code.** It returns `undefined`.

```tsx
// Correct
const isMac = window.topBarAPI?.platform === 'darwin'
const isLinux = window.topBarAPI?.platform === 'linux'

// Correct: macOS traffic light spacer
{isMac && <div className="pl-[88px]" />}
// On Linux/Windows show 🫐 logo instead
```

---

## 12. Dark Mode

- Every color must have a dark variant or use tokens that auto-adapt.
- Toggle via `document.documentElement.classList.toggle('dark', isDarkMode)`.
- Test both modes before marking anything done.
- Prefer token-based colors (`bg-background`, `text-foreground`) over explicit `dark:` overrides when possible.

---

## 13. Checklist (new feature)

Before shipping any UI:

- [ ] 🫐 used correctly — no sparkles or stars
- [ ] All colors via CSS variables or Tailwind tokens
- [ ] `cn()` used for all className composition
- [ ] Glassmorphism applied where appropriate (overlays, docked surfaces)
- [ ] Dark mode variants present and tested
- [ ] Hover + focus states on all interactive elements
- [ ] `cursor-pointer` on all clickable elements
- [ ] Explicit `React.FC` return type, named export
- [ ] `window.topBarAPI.platform` used for OS checks (not `process.platform`)
- [ ] Loading and empty states designed
- [ ] No inline styles

---

*Last updated: 2026-05-19*
