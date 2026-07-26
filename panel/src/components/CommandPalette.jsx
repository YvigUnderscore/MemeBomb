import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search, LayoutDashboard, Hash, Trophy, ShieldAlert, ScrollText, Users,
  Sun, Moon, Rows3, LogOut, CornerDownLeft, Sparkles,
} from 'lucide-react';
import { useTheme } from '../context/ThemeContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { ChannelAPI } from '../lib/api.js';

// Palette de commandes globale (Ctrl/Cmd+K) — navigation + actions rapides.
export default function CommandPalette({ open, onClose }) {
  const navigate = useNavigate();
  const { toggleTheme, density, setDensity } = useTheme();
  const { logout, isStaff, canManageChannels } = useAuth();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [channels, setChannels] = useState([]);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setQ(''); setSel(0);
    if (canManageChannels) ChannelAPI.list().then(setChannels).catch(() => {});
    setTimeout(() => inputRef.current?.focus(), 30);
  }, [open, canManageChannels]);

  const go = (to) => { onClose(); navigate(to); };
  // `staff` / `channels` : mêmes portées que la navigation — la palette ne doit
  // pas proposer une page sur laquelle la route va rediriger.
  const commands = useMemo(() => [
    { id: 'nav-dash', label: 'Dashboard', icon: LayoutDashboard, hint: 'Go to', staff: true, run: () => go('/') },
    { id: 'nav-channels', label: 'Channels', icon: Hash, hint: 'Go to', channels: true, run: () => go('/channels') },
    { id: 'nav-hall', label: 'Hall of Memes', icon: Trophy, hint: 'Go to', run: () => go('/hall') },
    { id: 'nav-mod', label: 'Moderation', icon: ShieldAlert, hint: 'Go to', staff: true, run: () => go('/moderation') },
    { id: 'nav-guide', label: 'Guidelines', icon: ScrollText, hint: 'Go to', staff: true, run: () => go('/guidelines') },
    { id: 'nav-account', label: 'Accounts', icon: Users, hint: 'Go to', staff: true, run: () => go('/account') },
    { id: 'act-theme', label: 'Toggle light / dark theme', icon: Moon, hint: 'Action', run: () => { toggleTheme(); onClose(); } },
    { id: 'act-density', label: `Density: switch to ${density === 'compact' ? 'comfortable' : 'compact'}`, icon: Rows3, hint: 'Action', run: () => { setDensity(density === 'compact' ? 'comfortable' : 'compact'); onClose(); } },
    { id: 'act-logout', label: 'Sign out', icon: LogOut, hint: 'Action', run: async () => { onClose(); await logout(); navigate('/login'); } },
    { id: 'dev-components', label: 'Catalogue de composants (dev)', icon: Sparkles, hint: 'Dev', staff: true, run: () => go('/_components') },
    ...channels.map((c) => ({ id: `ch-${c.id}`, label: `Channel : ${c.name}`, icon: Hash, hint: `/${c.slug}`, run: () => go(`/channels/${c.id}`) })),
  ].filter((c) => (c.staff ? isStaff : true) && (c.channels ? canManageChannels : true)),
  [channels, density, isStaff, canManageChannels]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(s) || (c.hint || '').toLowerCase().includes(s));
  }, [q, commands]);

  useEffect(() => { setSel(0); }, [q]);

  if (!open) return null;
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(filtered.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); filtered[sel]?.run(); }
    else if (e.key === 'Escape') { onClose(); }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-start justify-center pt-[12vh] px-4 bg-black/60 backdrop-blur-sm animate-fade-in" onMouseDown={onClose}>
      <div className="card w-full max-w-xl overflow-hidden animate-scale-in" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 border-b border-border">
          <Search size={18} className="text-muted" />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
            placeholder="Search a page, a channel, an action…"
            className="flex-1 bg-transparent py-4 outline-none text-sm text-ink placeholder:text-muted" />
          <kbd className="text-[10px] text-muted border border-border rounded px-1.5 py-0.5">Esc</kbd>
        </div>
        <div className="max-h-[50vh] overflow-auto py-2">
          {filtered.length === 0 ? <div className="px-4 py-6 text-sm text-muted text-center">No results.</div> : filtered.map((c, i) => {
            const Icon = c.icon;
            return (
              <button key={c.id} onMouseEnter={() => setSel(i)} onClick={c.run}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm ${i === sel ? 'bg-accent/15 text-ink' : 'text-ink/90 hover:bg-surface-2'}`}>
                <Icon size={16} className={i === sel ? 'text-accent' : 'text-muted'} />
                <span className="flex-1 truncate">{c.label}</span>
                <span className="text-[11px] text-muted">{c.hint}</span>
                {i === sel && <CornerDownLeft size={13} className="text-muted" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
