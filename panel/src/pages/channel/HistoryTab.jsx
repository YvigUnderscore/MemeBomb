import { useEffect, useMemo, useState } from 'react';
import {
  History, Trash2, Ban, Send, Image as ImageIcon, Film, Music, Type, X, Clock, Repeat,
  Search, Eye, LayoutGrid, List, ChevronDown,
} from 'lucide-react';
import { ChannelAPI } from '../../lib/api.js';
import { Card, Badge, EmptyState, Spinner, Modal, Skeleton } from '../../components/ui.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useConfirm } from '../../components/Confirm.jsx';
import MemberProfile from './MemberProfile.jsx';

const ICONS = { image: ImageIcon, gif: Film, video: Film, audio: Music, text: Type };
const STATUS = ['all', 'sent', 'pending', 'blocked', 'removed'];
const TYPES = ['all', 'image', 'gif', 'video', 'audio', 'text'];
const SORTS = [{ id: 'date', label: 'Most recent' }, { id: 'reactions', label: 'Most reacted' }, { id: 'views', label: 'Most viewed' }];
const RECEIPT_LABELS = { displayed: 'displayed', skipped: 'skipped', dnd: 'do not disturb', error: 'error', throttled: 'throttled' };
const PAGE = 30;
const isDiscordId = (s) => /^\d{5,25}$/.test(String(s || ''));
const rxTotal = (m) => Object.values(m.reactions || {}).reduce((a, b) => a + b, 0);

function Receipts({ m }) {
  const r = m.receipts || {};
  const reactions = m.reactions || {};
  const parts = [];
  if (r.displayed) parts.push(<span key="d" className="text-success">{r.displayed} vu(s)</span>);
  if (r.throttled) parts.push(<span key="t" className="text-warning">{r.throttled} quota</span>);
  if (r.dnd) parts.push(<span key="n" className="text-muted">{r.dnd} DND</span>);
  if (r.error) parts.push(<span key="e" className="text-danger">{r.error} err</span>);
  const rx = Object.entries(reactions);
  return (
    <div className="flex items-center gap-2 text-xs mt-1 flex-wrap">
      {parts.length > 0 && <span className="flex items-center gap-1.5">{parts.reduce((a, p, i) => i ? [...a, <span key={`s${i}`} className="text-muted">·</span>, p] : [p], [])}</span>}
      {rx.length > 0 && <span className="flex items-center gap-1">{rx.map(([e, c]) => <span key={e} className="bg-surface border border-border rounded-full px-1.5">{e} {c}</span>)}</span>}
    </div>
  );
}

// Lightbox (#11) : aperçu média plein cadre.
function Lightbox({ meme, onClose }) {
  if (!meme) return null;
  return (
    <div className="fixed inset-0 z-[90] grid place-items-center p-6 bg-black/80 backdrop-blur-sm animate-fade-in" onMouseDown={onClose}>
      <div className="max-w-4xl w-full animate-scale-in" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-2 text-white">
          <div className="text-sm truncate">{meme.text || <span className="opacity-60 italic">(sans texte)</span>} — <span className="opacity-70">{meme.sender_name || meme.sender}</span></div>
          <button onClick={onClose} aria-label="Close" className="text-white/70 hover:text-white"><X size={22} /></button>
        </div>
        <div className="rounded-2xl overflow-hidden bg-black grid place-items-center max-h-[75vh]">
          {meme.type === 'image' && <img src={meme.mediaUrl} alt="" className="max-h-[75vh] w-auto object-contain" />}
          {(meme.type === 'video' || meme.type === 'gif') && <video src={meme.mediaUrl} controls autoPlay loop className="max-h-[75vh]" />}
          {meme.type === 'audio' && <div className="p-10 w-full"><audio src={meme.mediaUrl} controls autoPlay className="w-full" /></div>}
          {(!meme.mediaUrl || meme.type === 'text') && <div className="p-16 text-2xl font-extrabold text-white text-center whitespace-pre-line">{meme.text}</div>}
        </div>
      </div>
    </div>
  );
}

export default function HistoryTab({ channel }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState(null);
  const [status, setStatus] = useState('all');
  const [type, setType] = useState('all');
  const [q, setQ] = useState('');
  const [sender, setSender] = useState('');
  const [sort, setSort] = useState('date');
  const [view, setView] = useState('list');
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detail, setDetail] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [profile, setProfile] = useState(null);

  const fetchPage = (off, append) => {
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(off), status, type });
    if (q.trim()) params.set('q', q.trim());
    if (sender.trim()) params.set('sender', sender.trim());
    return ChannelAPI.memes(channel.id, `?${params.toString()}`).then((data) => {
      setHasMore(data.length === PAGE);
      setRows((prev) => (append && prev ? [...prev, ...data] : data));
    }).catch((e) => toast.error(e.message));
  };
  const load = () => { setOffset(0); setRows(null); fetchPage(0, false); };
  const loadMore = async () => { const next = offset + PAGE; setLoadingMore(true); setOffset(next); await fetchPage(next, true); setLoadingMore(false); };

  useEffect(() => { load(); }, [channel.id, status, type]); // eslint-disable-line react-hooks/exhaustive-deps

  const sorted = useMemo(() => {
    if (!rows) return rows;
    const arr = [...rows];
    if (sort === 'reactions') arr.sort((a, b) => rxTotal(b) - rxTotal(a));
    else if (sort === 'views') arr.sort((a, b) => (b.receipts?.displayed || 0) - (a.receipts?.displayed || 0));
    return arr;
  }, [rows, sort]);

  const remove = async (m) => { if (!(await confirm({ message: 'Remove this meme and its media?', danger: true, confirmLabel: 'Remove' }))) return; try { await ChannelAPI.removeMeme(channel.id, m.id); load(); } catch (e) { toast.error(e.message); } };
  const approve = async (m) => { try { await ChannelAPI.approveMeme(channel.id, m.id); toast.success('Meme approved and delivered'); load(); } catch (e) { toast.error(e.message); } };
  const reject = async (m) => { if (!(await confirm({ message: 'Reject this meme? Its media will be deleted.', danger: true, confirmLabel: 'Reject' }))) return; try { await ChannelAPI.rejectMeme(channel.id, m.id); load(); } catch (e) { toast.error(e.message); } };
  const resend = async (m) => { try { const r = await ChannelAPI.resendMeme(channel.id, m.id); toast.success(`Meme re-sent to ${r.delivered} screen(s)`); load(); } catch (e) { toast.error(e.message); } };
  const openDetail = async (m) => { try { const d = await ChannelAPI.memeReceipts(channel.id, m.id); setDetail({ m, ...d }); } catch (e) { toast.error(e.message); } };
  const openSender = (m) => { if (isDiscordId(m.sender)) setProfile({ discord_id: m.sender, discord_username: m.sender_name || m.sender, role: 'user', can_send: 1, banned: 0 }); };

  const Thumb = ({ m, size = 'w-12 h-12' }) => {
    const Icon = ICONS[m.type] || Type;
    const clickable = m.mediaUrl || m.text;
    return (
      <button onClick={() => clickable && setLightbox(m)} disabled={!clickable}
        className={`${size} rounded-lg bg-black grid place-items-center overflow-hidden shrink-0 ${clickable ? 'cursor-zoom-in hover:ring-2 hover:ring-accent/50' : ''}`}>
        {m.mediaUrl && m.type === 'image' ? <img src={m.mediaUrl} alt="" className="w-full h-full object-cover" />
          : m.mediaUrl && (m.type === 'video' || m.type === 'gif') ? <video src={m.mediaUrl} className="w-full h-full object-cover" muted />
            : <Icon size={20} className="text-muted" />}
      </button>
    );
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h3 className="font-bold">Historique</h3>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1">
            {STATUS.map((f) => (
              <button key={f} onClick={() => setStatus(f)}
                className={`chip border ${status === f ? 'chip-on' : 'chip-off'}`}>{f}</button>
            ))}
          </div>
          <div className="flex rounded-lg border border-border overflow-hidden">
            <button onClick={() => setView('list')} aria-label="List view" className={`px-2 py-1.5 ${view === 'list' ? 'bg-accent/15 text-accent' : 'text-muted hover:text-ink'}`}><List size={15} /></button>
            <button onClick={() => setView('gallery')} aria-label="Gallery view" className={`px-2 py-1.5 ${view === 'gallery' ? 'bg-accent/15 text-accent' : 'text-muted hover:text-ink'}`}><LayoutGrid size={15} /></button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-2 mb-4">
        <label className="block">
          <span className="label">Type</span>
          <select className="input !py-1.5" value={type} onChange={(e) => setType(e.target.value)}>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="label">Trier</span>
          <select className="input !py-1.5" value={sort} onChange={(e) => setSort(e.target.value)}>
            {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <label className="block flex-1 min-w-[140px]">
          <span className="label">Sender</span>
          <input className="input !py-1.5" value={sender} placeholder="pseudo ou id"
            onChange={(e) => setSender(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} />
        </label>
        <label className="block flex-1 min-w-[140px]">
          <span className="label">Recherche texte</span>
          <input className="input !py-1.5" value={q} placeholder="mots du meme"
            onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} />
        </label>
        <button className="btn-ghost" onClick={load}><Search size={15} /> Filtrer</button>
      </div>

      {!rows ? <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16" />)}</div>
        : sorted.length === 0 ? <EmptyState icon={History} title="Nothing to show" hint="Adjust the filters or send your first meme." />
        : view === 'gallery' ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {sorted.map((m) => (
              <div key={m.id} className="group relative rounded-xl overflow-hidden border border-border bg-surface-2">
                <div className="aspect-video">
                  <Thumb m={m} size="w-full h-full !rounded-none" />
                </div>
                <div className="p-2">
                  <div className="text-xs truncate">{m.text || <span className="text-muted italic">(sans texte)</span>}</div>
                  <div className="text-[11px] text-muted flex items-center justify-between mt-1">
                    <button onClick={() => openSender(m)} className={isDiscordId(m.sender) ? 'hover:text-accent truncate' : 'truncate'}>{m.sender_name || m.sender}</button>
                    {rxTotal(m) > 0 && <span className="shrink-0">🔥 {rxTotal(m)}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {sorted.map((m) => (
              <div key={m.id} className="flex items-center gap-3 bg-surface-2 border border-border rounded-xl p-3 dense-row">
                <Thumb m={m} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">{m.text || <span className="text-muted italic">(sans texte)</span>}</div>
                  <div className="text-xs text-muted flex items-center gap-2 mt-0.5">
                    <button onClick={() => openSender(m)} className={isDiscordId(m.sender) ? 'hover:text-accent' : ''}>{m.sender_name || m.sender}</button> ·
                    <span>{m.source}</span> ·
                    <span>{new Date(m.created_at).toLocaleString('fr-FR')}</span>
                  </div>
                  <Receipts m={m} />
                </div>
                {m.status === 'blocked' && <Badge tone="danger"><Ban size={12} /> blocked</Badge>}
                {m.status === 'removed' && <Badge tone="warning">removed</Badge>}
                {m.status === 'pending' && <Badge tone="warning"><Clock size={12} /> en attente</Badge>}
                {m.status === 'sent' && <Badge tone="success"><Send size={12} /> {m.targets.length || 'tous'}</Badge>}
                {m.status === 'sent' && <button title="Delivery receipts" aria-label="Receipts" onClick={() => openDetail(m)} className="btn-ghost !px-2.5"><Eye size={14} /></button>}
                {m.status === 'pending' && (
                  <>
                    <button aria-label="Approve" onClick={() => approve(m)} className="btn-ghost !px-2.5 text-success"><Send size={14} /></button>
                    <button aria-label="Reject" onClick={() => reject(m)} className="btn-ghost !px-2.5 text-danger"><X size={14} /></button>
                  </>
                )}
                {m.status === 'sent' && <button title="Re-send" aria-label="Re-send" onClick={() => resend(m)} className="btn-ghost !px-2.5"><Repeat size={14} /></button>}
                {m.status === 'sent' && <button aria-label="Remove" onClick={() => remove(m)} className="btn-ghost !px-2.5 text-danger"><Trash2 size={14} /></button>}
              </div>
            ))}
          </div>
        )}

      {hasMore && sort === 'date' && (
        <div className="flex justify-center mt-4">
          <button className="btn-ghost" disabled={loadingMore} onClick={loadMore}>{loadingMore ? <Spinner /> : <ChevronDown size={16} />} Charger plus</button>
        </div>
      )}
      {hasMore && sort !== 'date' && <p className="text-xs text-muted text-center mt-3">Sorting applies to loaded memes. Switch back to Most recent to load more.</p>}

      {detail && (
        <Modal open onClose={() => setDetail(null)} title="Delivery receipts & reactions" wide>
          <div className="space-y-4">
            <div>
              <h4 className="font-semibold mb-2 text-sm">Receipts ({detail.receipts.length})</h4>
              {detail.receipts.length === 0 ? <p className="text-sm text-muted">No receipts yet.</p> : (
                <div className="divide-y divide-border max-h-60 overflow-auto">
                  {detail.receipts.map((r) => (
                    <div key={r.device_id} className="flex items-center justify-between py-1.5 text-sm">
                      <span>{r.name || `Appareil #${r.device_id}`}</span>
                      <Badge tone={r.status === 'displayed' ? 'success' : r.status === 'error' ? 'danger' : 'warning'}>{RECEIPT_LABELS[r.status] || r.status}</Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <h4 className="font-semibold mb-2 text-sm">Reactions ({detail.reactions.length})</h4>
              {detail.reactions.length === 0 ? <p className="text-sm text-muted">No reactions.</p> : (
                <div className="flex flex-wrap gap-2">
                  {detail.reactions.map((r, i) => (
                    <span key={i} className="chip bg-surface border border-border">{r.emoji} {r.name || `#${r.device_id}`}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Modal>
      )}

      <Lightbox meme={lightbox} onClose={() => setLightbox(null)} />
      {profile && <MemberProfile channel={channel} member={profile} onClose={() => setProfile(null)} />}
    </Card>
  );
}
