import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Trophy, Crown, Medal, Award, Image as ImageIcon, Film, Music, Type, Flame,
  MessageCircle, X, Send, Trash2, Archive, Radio,
} from 'lucide-react';
import { HallAPI } from '../lib/api.js';
import { usePanelWS } from '../context/PanelWS.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { Card, EmptyState, Badge, Skeleton, Spinner } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';

const ICONS = { image: ImageIcon, gif: Film, video: Film, audio: Music, text: Type };
const EMOJIS = ['😂', '❤️', '🔥', '💀', '👏', '😮', '👎', '🤡'];
const RANK = [
  { icon: Crown, cls: 'text-yellow-400' },
  { icon: Medal, cls: 'text-slate-300' },
  { icon: Award, cls: 'text-amber-600' },
];

const fmtWeek = (w) => {
  const d = new Date(`${w}T00:00:00`);
  const end = new Date(d.getTime() + 6 * 86400000);
  const f = (x) => x.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${f(d)} → ${f(end)}`;
};

function MemeThumb({ m }) {
  const Icon = ICONS[m.type] || Type;
  if (m.mediaUrl && m.type === 'image') return <img src={m.mediaUrl} alt="" className="w-full h-full object-cover" />;
  if (m.mediaUrl && (m.type === 'video' || m.type === 'gif')) return <video src={m.mediaUrl} className="w-full h-full object-cover" muted loop autoPlay playsInline />;
  if (m.type === 'audio') return <div className="w-full h-full grid place-items-center bg-gradient-to-br from-accent/20 to-surface-2"><Music size={28} className="text-muted" /></div>;
  return (
    <div className="w-full h-full grid place-items-center bg-gradient-to-br from-accent/20 to-surface-2 p-2 text-center">
      {m.text ? <span className="text-xs font-bold text-ink line-clamp-4">{m.text}</span> : <Icon size={26} className="text-muted" />}
    </div>
  );
}

// Barre de réactions du Hall (comptes panel, toggle).
function HallReactions({ meme, onChange }) {
  const toast = useToast();
  const react = async (emoji) => {
    try { const r = await HallAPI.react(meme.memeId, emoji); onChange(meme.memeId, r); }
    catch (e) { toast.error(e.message); }
  };
  return (
    <div className="flex flex-wrap gap-1">
      {EMOJIS.map((e) => {
        const n = meme.hallReactions?.[e] || 0;
        const mine = (meme.myReactions || []).includes(e);
        return (
          <button key={e} onClick={(ev) => { ev.stopPropagation(); react(e); }}
            className={`chip border text-sm leading-none transition ${mine ? 'bg-accent/20 border-accent/50' : n ? 'bg-surface-2 border-border' : 'bg-surface-2 border-border opacity-50 hover:opacity-100'}`}>
            {e}{n ? ` ${n}` : ''}
          </button>
        );
      })}
    </div>
  );
}

// Visionneuse : média rejouable + commentaires + réactions.
function MemeViewer({ meme, onClose, onReaction }) {
  const toast = useToast();
  const { isAdmin, user } = useAuth();
  const isStaff = user?.role === 'admin' || user?.role === 'moderator';
  const [comments, setComments] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);

  const load = () => HallAPI.comments(meme.memeId).then(setComments).catch((e) => toast.error(e.message));
  useEffect(() => { load(); }, [meme.memeId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [comments]);

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    try { await HallAPI.addComment(meme.memeId, t); setText(''); load(); }
    catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  const del = async (c) => {
    try { await HallAPI.deleteComment(c.id); load(); } catch (e) { toast.error(e.message); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm grid place-items-center p-4" onClick={onClose}>
      <div className="card w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 p-4 border-b border-border">
          <div className="flex-1 min-w-0">
            <div className="font-bold truncate">{meme.text || `(${meme.type})`}</div>
            <div className="text-xs text-muted">by {meme.senderName || meme.sender} · {meme.createdAt ? new Date(meme.createdAt).toLocaleString() : ''} · <Flame size={11} className="inline" /> {meme.reactions} overlay reaction(s)</div>
          </div>
          <button className="btn-ghost !px-2.5" onClick={onClose} aria-label="Close"><X size={17} /></button>
        </div>

        <div className="overflow-auto">
          <div className="bg-black grid place-items-center max-h-[45vh]">
            {meme.mediaUrl && meme.type === 'image' && <img src={meme.mediaUrl} alt="" className="max-h-[45vh] object-contain" />}
            {meme.mediaUrl && (meme.type === 'video' || meme.type === 'gif') && (
              <video src={meme.mediaUrl} className="max-h-[45vh]" controls autoPlay loop={meme.type === 'gif'} playsInline />
            )}
            {meme.mediaUrl && meme.type === 'audio' && (
              <div className="p-6 w-full grid place-items-center gap-3"><Music size={34} className="text-muted" /><audio src={meme.mediaUrl} controls autoPlay className="w-full max-w-md" /></div>
            )}
            {!meme.mediaUrl && (
              <div className="p-10 text-center">
                {meme.text ? <div className="text-2xl font-extrabold text-white whitespace-pre-line">{meme.text}</div>
                  : <div className="text-sm text-muted">Media unavailable (purged before it was archived).</div>}
              </div>
            )}
          </div>

          <div className="p-4 space-y-4">
            <HallReactions meme={meme} onChange={onReaction} />

            <div>
              <h4 className="font-bold text-sm mb-2 flex items-center gap-1.5"><MessageCircle size={15} /> Comments {comments ? `(${comments.length})` : ''}</h4>
              {!comments ? <Spinner className="text-accent" /> : comments.length === 0 ? (
                <p className="text-sm text-muted">No comments yet. Be the first!</p>
              ) : (
                <div className="space-y-2 max-h-[30vh] overflow-auto pr-1">
                  {comments.map((c) => (
                    <div key={c.id} className="flex items-start gap-2 text-sm">
                      <div className="flex-1 min-w-0 bg-surface-2 border border-border rounded-xl px-3 py-2">
                        <span className="font-semibold text-accent">{c.username}</span>
                        <span className="text-[11px] text-muted ml-2">{new Date(c.createdAt).toLocaleString()}</span>
                        <div className="mt-0.5 break-words">{c.text}</div>
                      </div>
                      {(c.mine || isStaff || isAdmin) && (
                        <button className="btn-ghost !px-2 text-danger mt-1" onClick={() => del(c)} aria-label="Delete"><Trash2 size={13} /></button>
                      )}
                    </div>
                  ))}
                  <div ref={endRef} />
                </div>
              )}
              <div className="flex gap-2 mt-3">
                <input className="input flex-1" placeholder="Add a comment…" value={text} maxLength={500}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') send(); }} />
                <button className="btn-primary" disabled={busy || !text.trim()} onClick={send}>{busy ? <Spinner /> : <Send size={15} />}</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Hall() {
  const toast = useToast();
  const [channels, setChannels] = useState(null);
  const [channelId, setChannelId] = useState('');
  const [weeks, setWeeks] = useState(null);
  const [week, setWeek] = useState('current');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [viewer, setViewer] = useState(null); // memeId ouvert
  const reloadRef = useRef(() => {});

  useEffect(() => {
    HallAPI.channels().then((list) => {
      setChannels(list);
      if (list.length) setChannelId((prev) => prev || String(list[0].id));
    }).catch((e) => toast.error(e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!channelId) return;
    setWeek('current');
    HallAPI.weeks(channelId).then(setWeeks).catch(() => setWeeks({ weeks: [] }));
  }, [channelId]);

  const load = useMemo(() => async () => {
    if (!channelId) return;
    setLoading(true);
    try { setData(week === 'all' ? await HallAPI.all(channelId, { offset: 0 }) : await HallAPI.top(channelId, week)); }
    catch (e) { toast.error(e.message); }
    finally { setLoading(false); }
  }, [channelId, week]); // eslint-disable-line react-hooks/exhaustive-deps
  reloadRef.current = load;

  // Mode « tous les memes » : pagination « charger plus » (ajoute à la suite).
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMore = async () => {
    if (!channelId || !data?.hasMore) return;
    setLoadingMore(true);
    try {
      const next = await HallAPI.all(channelId, { offset: data.memes.length });
      setData((d) => ({ ...next, memes: [...(d?.memes || []), ...next.memes] }));
    } catch (e) { toast.error(e.message); }
    finally { setLoadingMore(false); }
  };

  useEffect(() => { setData(null); load(); }, [load]);

  // Semaine courante en direct : réactions overlay → rechargement (débounce).
  const panelWS = usePanelWS();
  useEffect(() => {
    let t = null;
    const stop = panelWS.subscribe((msg) => {
      if ((msg.type === 'reaction' || msg.type === 'milestone') && String(msg.channelId) === String(channelId) && week === 'current') {
        clearTimeout(t); t = setTimeout(() => reloadRef.current(), 1200);
      }
    });
    return () => { clearTimeout(t); stop(); };
  }, [channelId, week, panelWS]);

  // Après une réaction Hall : recharge (compteurs + « mes réactions » exacts).
  const onReaction = () => reloadRef.current();

  const memes = data?.memes || [];
  const viewerMeme = viewer ? memes.find((m) => m.memeId === viewer) : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-accent-gradient grid place-items-center shadow-glow"><Trophy size={22} className="text-white" /></div>
        <div>
          <h1 className="text-2xl font-extrabold">Hall of Memes</h1>
          <p className="text-sm text-muted">Browse all PUBLIC memes per channel, or the live weekly top 10 — every past week's top 10 is archived forever.</p>
        </div>
      </div>

      <Card className="flex flex-wrap items-end gap-4">
        <label className="block">
          <span className="label">Channel</span>
          <select className="input !py-1.5 min-w-[160px]" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
            {(channels || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="label">Week</span>
          <select className="input !py-1.5 min-w-[220px]" value={week} onChange={(e) => setWeek(e.target.value)}>
            <option value="current">🔴 This week (live)</option>
            <option value="all">📚 All public memes</option>
            {(weeks?.weeks || []).map((w) => <option key={w} value={w}>🗄️ {fmtWeek(w)}</option>)}
          </select>
        </label>
        {data && (
          <div className="pb-1.5">
            {data.all
              ? <Badge><ImageIcon size={12} /> all public memes</Badge>
              : data.live
                ? <Badge tone="success"><Radio size={12} /> live — archived on Monday</Badge>
                : <Badge><Archive size={12} /> archived week ({fmtWeek(data.week)})</Badge>}
          </div>
        )}
      </Card>

      {loading && !data ? (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="card !p-0 overflow-hidden"><Skeleton className="aspect-video !rounded-none" /><div className="p-3 space-y-2"><Skeleton className="h-3 w-3/4" /><Skeleton className="h-3 w-1/2" /></div></div>
          ))}
        </div>
      ) : memes.length === 0 ? (
        <EmptyState icon={Trophy}
          title={week === 'all' ? 'No public memes in this channel yet' : week === 'current' ? 'No memes with reactions this week' : 'No archive for this week'}
          hint={week === 'current' ? 'As soon as memes get reactions, they will show up here.' : undefined} />
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {memes.map((m) => {
            const rank = RANK[m.rank - 1];
            return (
              <Card key={m.memeId} className="!p-0 overflow-hidden flex flex-col cursor-pointer hover:border-accent/50 transition"
                onClick={() => setViewer(m.memeId)}>
                <div className="relative aspect-video bg-black overflow-hidden">
                  <MemeThumb m={m} />
                  {m.rank ? (
                    <div className="absolute top-2 left-2 flex items-center gap-1.5">
                      {rank ? <span className={`w-7 h-7 rounded-full bg-black/70 grid place-items-center ${rank.cls}`}><rank.icon size={15} /></span>
                        : <span className="w-7 h-7 rounded-full bg-black/70 grid place-items-center text-xs font-bold text-white">{m.rank}</span>}
                    </div>
                  ) : null}
                  <div className="absolute top-2 right-2 flex gap-1.5">
                    <Badge tone="accent"><Flame size={12} /> {m.reactions}</Badge>
                    {m.comments > 0 && <Badge><MessageCircle size={12} /> {m.comments}</Badge>}
                  </div>
                </div>
                <div className="p-3 flex-1 flex flex-col gap-2">
                  <div className="text-sm truncate">{m.text || <span className="text-muted italic">({m.type})</span>}</div>
                  <div className="text-xs text-muted">by <span className="text-ink">{m.senderName || m.sender}</span>
                    {m.createdAt ? <> · {new Date(m.createdAt).toLocaleDateString()}</> : null}</div>
                  <div className="flex flex-wrap gap-1">
                    {Object.entries(m.reactionDetail || {}).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([e, c]) => (
                      <span key={e} className="chip bg-surface border border-border text-xs">{e} {c}</span>
                    ))}
                  </div>
                  <div className="mt-auto pt-1" onClick={(e) => e.stopPropagation()}>
                    <HallReactions meme={m} onChange={onReaction} />
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {week === 'all' && data?.hasMore && memes.length > 0 && (
        <div className="grid place-items-center">
          <button className="btn-ghost" disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? <Spinner /> : 'Load more'}
          </button>
        </div>
      )}

      {viewerMeme && <MemeViewer meme={viewerMeme} onClose={() => setViewer(null)} onReaction={onReaction} />}
    </div>
  );
}
