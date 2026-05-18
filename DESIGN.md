## 📘 Blueberry Browser — AI Coding Standards

### 1. Philosophy
- **Minimal, clean, purposeful.** Every line must justify its existence.
- **Glassmorphism + blueberry palette.** No exceptions.
- **macOS-first, cross-platform.** Always check `window.topBarAPI.platform` (not `process.platform` in renderer).
- **Emoji brand identity.** 🫐 is the logo. No sparkles, no stars, no generic icons.

---

### 2. Design System (LOCKED)

**Colors** — use CSS variables only, never hardcode:
```css
/* Light */
--primary: 59 91 219;        /* Blueberry blue */
--background: 250 252 255;   /* Cool white */
--foreground: 15 23 42;      /* Slate 900 */
--muted-foreground: 100 116 139;
--border: 226 232 240;

/* Dark */
--primary: 99 130 255;       /* Lighter blue */
--background: 10 14 26;      /* Deep navy */
--foreground: 248 250 252;
--muted-foreground: 148 163 184;
--border: 51 65 85;
```

**Glassmorphism** — use these exact utility classes:
```css
.glass {
    background: rgba(250, 252, 255, 0.72);
    backdrop-filter: blur(20px) saturate(1.6);
    -webkit-backdrop-filter: blur(20px) saturate(1.6);
    border-bottom: 1px solid rgba(226, 232, 240, 0.6);
}
.dark .glass {
    background: rgba(10, 14, 26, 0.72);
    border-bottom: 1px solid rgba(51, 65, 85, 0.5);
}
```

**Border radius scale:**
- Pills/inputs: `rounded-full` or `rounded-xl` (12px)
- Cards: `rounded-2xl` (16px)
- Buttons: `rounded-lg` (8px) or `rounded-xl`

**Shadows:**
- Subtle: `shadow-[0_1px_3px_rgba(0,0,0,0.04)]`
- Elevated: `shadow-lg` or `shadow-[0_8px_16px_rgba(0,0,0,0.08)]`

---

### 3. Component Rules

**React components:**
- Use functional components with explicit return types: `React.FC`
- Props interface always named `[ComponentName]Props`
- One component per file, named export
- No `default` exports — always named

**ClassName composition:**
- Always use `cn()` from `@common/lib/utils`
- Order: layout → spacing → sizing → colors → effects → interactive → dark variants
- Example:
```tsx
className={cn(
    "flex items-center gap-2 px-3 py-1.5",  // layout/spacing
    "h-8 rounded-full",                      // sizing/shape
    "bg-secondary/80 text-foreground",       // colors
    "hover:bg-secondary transition-all",     // interactive
    "dark:bg-secondary/40"                   // dark
)}
```

**No inline styles.** Ever. Use Tailwind or CSS variables.

---

### 4. Platform Awareness

**NEVER use `process.platform` in renderer code.** It returns `undefined`.

**ALWAYS use the exposed platform:**
```tsx
const isMac = window.topBarAPI?.platform === 'darwin'
const isWin = window.topBarAPI?.platform === 'win32'
const isLinux = window.topBarAPI?.platform === 'linux'
```

**macOS traffic lights:**
- Only render `pl-[88px]` spacing when `isMac`
- On Linux/Windows, show 🫐 logo instead

---

### 5. Brand Identity (NON-NEGOTIABLE)

| Element | Value |
|---------|-------|
| Logo | 🫐 (blueberry emoji) |
| App name | Blueberry Browser |
| AI name | Blueberry AI |
| Loading indicator | 🫐 with `animate-pulse` |
| Empty state icon | Large 🫐 (text-5xl or bigger) |
| **Forbidden icons** | Sparkles, stars, magic wands, robots, brains |

---

### 6. File Structure

```
src/
  main/           # Electron main process — Node APIs allowed
  preload/        # Bridge scripts — only place process.platform is valid
  renderer/
    common/       # Shared components, hooks, utils
    topbar/       # TopBar React app
    sidebar/      # Sidebar React app
```

**Import aliases:**
- `@common/*` → `src/renderer/common/*`
- `@renderer/*` → `src/renderer/src/*`

---

### 7. IPC Patterns

**Preload exposes APIs only.** Renderer never calls `ipcRenderer` directly.

**Naming convention:**
- `handle` for invoke: `ipcMain.handle("create-tab", ...)`
- `on` for events: `ipcMain.on("dark-mode-changed", ...)`
- Channel names: kebab-case, descriptive

---

### 8. TypeScript Rules

- Strict mode. No `any` without comment justification.
- Preload `.d.ts` must stay in sync with actual preload API.
- Use `CoreMessage` from `ai` package, don't reinvent.

---

### 9. State & Logic

**Main process:** owns truth (tabs, windows, sessions).
**Renderer:** reflects truth, requests changes via IPC.
**No renderer-to-renderer direct communication.** Always through main.

---

### 10. New Features Checklist

Before submitting any new feature code, verify:

- [ ] 🫐 used correctly, no sparkles
- [ ] `window.topBarAPI.platform` used for OS checks
- [ ] `cn()` used for all className composition
- [ ] CSS variables used, no hardcoded colors
- [ ] Glassmorphism applied where appropriate
- [ ] Dark mode variants present
- [ ] Component has explicit `React.FC` return type
- [ ] Named export, not default
- [ ] Preload types updated if API changed
- [ ] No `process.platform` in renderer

