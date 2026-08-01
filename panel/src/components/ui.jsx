import { useEffect, useRef, useState } from 'react';
import { X, Loader2, Check, Copy } from 'lucide-react';

// `onClick` doit être transmis : sans lui, une carte cliquable (le Hall) est
// inerte — c'est ce qui empêchait d'ouvrir la visionneuse d'un meme. Une carte
// cliquable devient aussi atteignable au clavier, sinon elle n'existe que pour
// la souris.
export function Card({ children, className = '', onClick }) {
  const clickable = typeof onClick === 'function';
  const keyProps = clickable ? {
    role: 'button', tabIndex: 0,
    onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); } },
  } : {};
  return <div className={`card p-5 animate-fade-in ${className}`} onClick={onClick} {...keyProps}>{children}</div>;
}

export function Spinner({ className = '' }) {
  return <Loader2 className={`animate-spin ${className}`} size={18} />;
}

export function Field({ label, hint, children }) {
  return (
    <label className="block">
      {label && <span className="label">{label}</span>}
      {children}
      {hint && <span className="block text-xs text-muted mt-1">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, hint }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 dense-row">
      <div>
        <div className="text-sm font-medium text-ink">{label}</div>
        {hint && <div className="text-xs text-muted mt-0.5">{hint}</div>}
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${checked ? 'bg-accent' : 'bg-surface-2 border border-border'}`}
        aria-pressed={checked}
        role="switch"
        aria-label={label}
      >
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${checked ? 'translate-x-5' : ''}`} />
      </button>
    </div>
  );
}

export function Badge({ children, tone = 'default', title }) {
  const tones = {
    default: 'bg-surface-2 text-muted border border-border',
    accent: 'bg-accent/15 text-accent border border-accent/30',
    success: 'bg-success/15 text-success border border-success/30',
    danger: 'bg-danger/15 text-danger border border-danger/30',
    warning: 'bg-warning/15 text-warning border border-warning/30',
  };
  return <span className={`chip ${tones[tone] || tones.default}`} title={title}>{children}</span>;
}

export function Stat({ label, value, icon: Icon, tone = 'accent' }) {
  const tones = { accent: 'text-accent', success: 'text-success', danger: 'text-danger', warning: 'text-warning' };
  return (
    <Card className="flex items-center gap-4">
      {Icon && <div className={`w-11 h-11 rounded-xl bg-surface-2 grid place-items-center ${tones[tone]}`}><Icon size={22} /></div>}
      <div>
        <div className="text-2xl font-bold text-ink leading-none">{value}</div>
        <div className="text-xs text-muted mt-1">{label}</div>
      </div>
    </Card>
  );
}

export function Modal({ open, onClose, title, children, wide }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'Tab') {
        // Focus-trap simple.
        const focusable = ref.current?.querySelectorAll('a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])');
        if (!focusable || focusable.length === 0) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={`card p-6 w-full ${wide ? 'max-w-2xl' : 'max-w-md'} animate-scale-in`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold">{title}</h3>
          <button className="text-muted hover:text-ink" onClick={onClose} aria-label="Close"><X size={20} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function EmptyState({ icon: Icon, title, hint, action }) {
  return (
    <div className="text-center py-14 px-4 animate-fade-in">
      {Icon && <Icon className="mx-auto text-muted/40 mb-3" size={40} />}
      <div className="font-semibold text-ink">{title}</div>
      {hint && <div className="text-sm text-muted mt-1 max-w-sm mx-auto">{hint}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// ---- Squelettes de chargement (#6) --------------------------------------
export function Skeleton({ className = '', style }) {
  return <div className={`skeleton ${className}`} style={style} />;
}
export function SkeletonText({ lines = 3, className = '' }) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className="h-3" style={{ width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}
export function SkeletonCard() {
  return (
    <div className="card p-5 space-y-3">
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-8 w-1/2" />
      <Skeleton className="h-3 w-full" />
    </div>
  );
}

// ---- Info-bulle légère (#38) --------------------------------------------
export function Tooltip({ label, children }) {
  return (
    <span className="relative inline-flex group">
      {children}
      <span role="tooltip" className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-2 whitespace-nowrap
        rounded-lg bg-surface-2 border border-border px-2.5 py-1.5 text-xs text-ink shadow-card
        opacity-0 group-hover:opacity-100 transition-opacity z-50 max-w-xs">
        {label}
      </span>
    </span>
  );
}

// ---- Bouton copier avec feedback « copié ! » (#42) ----------------------
export function CopyButton({ value, className = '', label = 'Copier', size = 14 }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(String(value)); }
    catch { /* fallback silencieux */ }
    setDone(true); setTimeout(() => setDone(false), 1400);
  };
  return (
    <button type="button" onClick={copy} aria-label={label} title={label}
      className={`inline-flex items-center gap-1 text-xs ${done ? 'text-success' : 'text-muted hover:text-ink'} transition ${className}`}>
      {done ? <Check size={size} /> : <Copy size={size} />}{done ? 'Copied!' : ''}
    </button>
  );
}

// ---- Sparkline SVG (#30) -------------------------------------------------
export function Sparkline({ data = [], width = 120, height = 32, className = '' }) {
  if (!data || data.length === 0) return <div className={`h-8 ${className}`} />;
  const max = Math.max(1, ...data);
  const n = data.length;
  const stepX = n > 1 ? width / (n - 1) : width;
  const pts = data.map((v, i) => [i * stepX, height - (v / max) * (height - 4) - 2]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} preserveAspectRatio="none" aria-hidden="true">
      <path d={area} fill="rgb(var(--c-accent) / 0.12)" />
      <path d={line} fill="none" stroke="rgb(var(--c-accent))" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// Bouton icône accessible réutilisable.
export function IconButton({ icon: Icon, label, onClick, tone = '', size = 15, className = '' }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label}
      className={`btn-ghost !px-2.5 ${tone} ${className}`}>
      <Icon size={size} />
    </button>
  );
}
