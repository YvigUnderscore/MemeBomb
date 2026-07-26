import { useEffect, useRef, useState } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Hash, ShieldAlert, ScrollText, Users, LogOut, Trophy,
  Sun, Moon, Menu, X, Command, Keyboard, Wifi, WifiOff, UserCircle, Server,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { useTheme } from '../context/ThemeContext.jsx';
import { usePanelWS } from '../context/PanelWS.jsx';
import CommandPalette from './CommandPalette.jsx';
import ShortcutsHelp from './ShortcutsHelp.jsx';
import { Tooltip } from './ui.jsx';

const nav = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true, key: 'd', staff: true },
  { to: '/channels', label: 'Channels', icon: Hash, key: 'c', channels: true },
  { to: '/hall', label: 'Hall of Memes', icon: Trophy, key: 'h' }, // accessible aussi aux membres
  { to: '/moderation', label: 'Moderation', icon: ShieldAlert, key: 'm', staff: true },
  { to: '/guidelines', label: 'Guidelines', icon: ScrollText, key: 'g', staff: true },
  { to: '/account', label: 'Accounts', icon: Users, key: 'a', staff: true },
  { to: '/admin', label: 'Admin', icon: Server, key: 's', admin: true },
  { to: '/profile', label: 'Profile', icon: UserCircle, key: 'p' },
];

function ConnDot() {
  const ws = usePanelWS();
  const s = ws?.status || 'connecting';
  const map = {
    online: { icon: Wifi, cls: 'text-success', label: 'Realtime connected' },
    connecting: { icon: Wifi, cls: 'text-warning animate-pulse', label: 'Connecting realtime…' },
    offline: { icon: WifiOff, cls: 'text-danger', label: 'Realtime offline — reconnecting…' },
  }[s];
  const Icon = map.icon;
  return <Tooltip label={map.label}><Icon size={15} className={map.cls} /></Tooltip>;
}

export default function Layout({ children }) {
  const { user, logout, isAdmin, isStaff, canManageChannels } = useAuth();
  const { resolved, toggleTheme } = useTheme();
  const panelWS = usePanelWS();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [modBadge, setModBadge] = useState(0);
  const seq = useRef({ g: false, t: 0 });

  // Les comptes 'member' ne voient que Profil et Hall — plus Channels s'ils
  // modèrent au moins un channel. Admin reste réservé aux admins.
  const visibleNav = nav.filter((n) => {
    if (n.admin) return isAdmin;
    if (n.staff) return isStaff;
    if (n.channels) return canManageChannels;
    return true;
  });

  const doLogout = async () => { await logout(); navigate('/login'); };

  // Badge « non-lus » modération (#19) : compte les événements en attente/signalements,
  // remis à zéro quand on visite la page Modération.
  useEffect(() => {
    const stop = panelWS.subscribe((msg) => {
      if ((msg.type === 'meme.pending' || msg.type === 'report.new') && location.pathname !== '/moderation') {
        setModBadge((n) => n + 1);
      }
    });
    return stop;
  }, [panelWS, location.pathname]);
  useEffect(() => { if (location.pathname === '/moderation') setModBadge(0); }, [location.pathname]);

  // Raccourcis clavier globaux (#5) : Ctrl/Cmd+K, ?, t, g→(d/c/h/m…).
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || e.target?.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); return; }
      if (typing) return;
      if (e.key === '?') { e.preventDefault(); setHelp(true); return; }
      const now = Date.now();
      if (e.key === 'g') { seq.current = { g: true, t: now }; return; }
      if (seq.current.g && now - seq.current.t < 1200) {
        const target = visibleNav.find((n) => n.key === e.key.toLowerCase());
        if (target) { e.preventDefault(); navigate(target.to); }
        seq.current = { g: false, t: 0 };
        return;
      }
      if (e.key.toLowerCase() === 't') { toggleTheme(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, toggleTheme]);

  const sidebar = (
    <aside className={`w-60 shrink-0 border-r border-border bg-surface/70 backdrop-blur flex flex-col p-4 gap-2
      fixed lg:sticky top-0 h-screen z-40 transition-transform ${mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
      <div className="flex items-center gap-2 px-2 py-3 mb-2">
        <img src="/logo.png" alt="MemeDrop" className="w-10 h-10 rounded-xl shadow-glow" />
        <div className="flex-1">
          <div className="font-extrabold text-lg leading-none">MemeDrop</div>
          <div className="text-[10px] text-muted uppercase tracking-widest">Panel</div>
        </div>
        <button className="lg:hidden text-muted hover:text-ink" onClick={() => setMobileOpen(false)} aria-label="Close menu"><X size={18} /></button>
      </div>

      <button onClick={() => setPalette(true)}
        className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm bg-surface-2 border border-border text-muted hover:text-ink hover:border-accent/50 transition">
        <Command size={15} /> Search…
        <kbd className="ml-auto text-[10px] border border-border rounded px-1.5 py-0.5">Ctrl K</kbd>
      </button>

      <nav className="flex flex-col gap-1 mt-1">
        {visibleNav.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} onClick={() => setMobileOpen(false)}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition
               ${isActive ? 'bg-accent-gradient text-white shadow-glow' : 'text-muted hover:text-ink hover:bg-surface-2'}`}>
            <Icon size={18} /> {label}
            {to === '/moderation' && modBadge > 0 && (
              <span className="ml-auto min-w-[18px] h-[18px] px-1 grid place-items-center text-[11px] font-bold rounded-full bg-danger text-white">{modBadge > 9 ? '9+' : modBadge}</span>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto pt-3 border-t border-border">
        <div className="flex items-center gap-2 px-2 mb-2">
          <ConnDot />
          <button onClick={toggleTheme} aria-label="Toggle theme" title="Toggle theme (t)"
            className="text-muted hover:text-ink">{resolved === 'dark' ? <Sun size={15} /> : <Moon size={15} />}</button>
          <button onClick={() => setHelp(true)} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)"
            className="text-muted hover:text-ink"><Keyboard size={15} /></button>
        </div>
        <div className="px-2 py-2 text-sm flex items-center gap-2">
          {user?.discordAvatarUrl && <img src={user.discordAvatarUrl} alt="" className="w-8 h-8 rounded-lg object-cover" />}
          <div className="min-w-0">
            <div className="font-semibold text-ink truncate">{user?.discordUsername || user?.username}</div>
            <div className="text-xs text-muted capitalize">{user?.role === 'member' ? 'member' : user?.role}</div>
          </div>
        </div>
        <button onClick={doLogout} className="btn-ghost w-full mt-1 text-danger border-danger/20 hover:border-danger/50">
          <LogOut size={16} /> Sign out
        </button>
      </div>
    </aside>
  );

  return (
    <div className="min-h-full flex">
      {sidebar}
      {mobileOpen && <div className="fixed inset-0 bg-black/50 z-30 lg:hidden" onClick={() => setMobileOpen(false)} />}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="lg:hidden flex items-center gap-3 p-4 border-b border-border sticky top-0 bg-surface/80 backdrop-blur z-20">
          <button onClick={() => setMobileOpen(true)} aria-label="Open menu" className="text-ink"><Menu size={22} /></button>
          <img src="/logo.png" alt="" className="w-7 h-7 rounded-lg" />
          <span className="font-bold">MemeDrop</span>
          <div className="ml-auto"><ConnDot /></div>
        </header>
        <main className="flex-1 min-w-0 p-6 md:p-8 max-w-[1400px] mx-auto w-full">{children}</main>
      </div>

      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      <ShortcutsHelp open={help} onClose={() => setHelp(false)} />
    </div>
  );
}
