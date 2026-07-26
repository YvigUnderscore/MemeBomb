import { useEffect, useState, useRef } from 'react';
import { ShieldAlert, Check, ScrollText, Clock, X, Send, Radio } from 'lucide-react';
import { SettingsAPI, ChannelAPI } from '../lib/api.js';
import { usePanelWS } from '../context/PanelWS.jsx';
import { Card, Badge, EmptyState, Spinner } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';
import { useConfirm } from '../components/Confirm.jsx';

// Aperçu média enrichi (#3) : lecture inline selon le type.
function PendingMedia({ m }) {
  if (!m.mediaUrl) {
    return <div className="w-full aspect-video rounded-lg bg-surface-2 grid place-items-center text-muted"><ShieldAlert size={26} /></div>;
  }
  if (m.type === 'image') return <img src={m.mediaUrl} alt="" className="w-full max-h-72 object-contain rounded-lg bg-black" />;
  if (m.type === 'video' || m.type === 'gif') return <video src={m.mediaUrl} controls loop className="w-full max-h-72 rounded-lg bg-black" />;
  if (m.type === 'audio') return <audio src={m.mediaUrl} controls className="w-full mt-2" />;
  return null;
}

export default function Moderation() {
  const toast = useToast();
  const confirm = useConfirm();
  const panelWS = usePanelWS();
  const [reports, setReports] = useState(null);
  const [audit, setAudit] = useState(null);
  const [pending, setPending] = useState(null);
  const loadRef = useRef(null);
  const live = panelWS.status === 'online';

  const load = () => {
    SettingsAPI.reports().then(setReports).catch((e) => toast.error(e.message));
    SettingsAPI.audit().then(setAudit).catch(() => {});
    SettingsAPI.pending().then(setPending).catch((e) => toast.error(e.message));
  };
  loadRef.current = load;
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Push temps réel (#4) : rafraîchit et notifie sur nouvel événement.
  useEffect(() => {
    const close = panelWS.subscribe((msg) => {
      if (msg.type === 'meme.pending') { toast.info?.(`Meme en attente de ${msg.sender}`); loadRef.current(); }
      else if (msg.type === 'report.new') { toast.info?.(`Nouveau signalement de ${msg.reporter}`); loadRef.current(); }
      else if (msg.type === 'meme.blocked' || msg.type === 'meme.sent') { loadRef.current(); }
    });
    return () => { close(); };
  }, [panelWS]); // eslint-disable-line react-hooks/exhaustive-deps

  const resolve = async (r) => { try { await SettingsAPI.resolveReport(r.id); load(); } catch (e) { toast.error(e.message); } };
  const approve = async (m) => { try { await ChannelAPI.approveMeme(m.channel_id, m.id); toast.success('Meme approved and delivered'); load(); } catch (e) { toast.error(e.message); } };
  const reject = async (m) => { if (!(await confirm({ message: 'Reject this meme? Its media will be deleted.', danger: true, confirmLabel: 'Reject' }))) return; try { await ChannelAPI.rejectMeme(m.channel_id, m.id); toast.success('Meme rejected'); load(); } catch (e) { toast.error(e.message); } };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold">Moderation</h1>
          <p className="text-muted text-sm">Reports and activity feed.</p>
        </div>
        <Badge tone={live ? 'success' : 'default'}><Radio size={12} /> {live ? 'realtime' : 'offline'}</Badge>
      </div>

      <Card>
        <h2 className="font-bold mb-4 flex items-center gap-2"><Clock size={18} /> Pending review
          {pending && pending.length > 0 && <Badge tone="warning">{pending.length}</Badge>}
        </h2>
        {!pending ? <Spinner className="text-accent" /> : pending.length === 0 ? (
          <EmptyState icon={Clock} title="Nothing pending" hint="Memes sent while manual review is enabled will show up here." />
        ) : (
          <div className="grid md:grid-cols-2 gap-4">
            {pending.map((m) => (
              <div key={m.id} className="bg-surface-2 border border-border rounded-xl p-3">
                <PendingMedia m={m} />
                {m.text && <div className="text-sm mt-2 break-words whitespace-pre-line">{m.text}</div>}
                <div className="text-xs text-muted flex items-center gap-2 mt-1">
                  <span>/{m.channel_slug}</span> · <span>{m.sender_name || m.sender}</span> · <span>{new Date(m.created_at).toLocaleString('fr-FR')}</span>
                </div>
                <div className="flex gap-2 mt-3">
                  <button className="btn-primary !py-1.5 flex-1" onClick={() => approve(m)}><Send size={14} /> Approve</button>
                  <button className="btn-ghost !px-2.5 text-danger" onClick={() => reject(m)}><X size={15} /> Reject</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <h2 className="font-bold mb-4 flex items-center gap-2"><ShieldAlert size={18} /> Reports</h2>
        {!reports ? <Spinner className="text-accent" /> : reports.length === 0 ? (
          <EmptyState icon={ShieldAlert} title="No reports" hint="All quiet for now." />
        ) : (
          <div className="divide-y divide-border">
            {reports.map((r) => (
              <div key={r.id} className="flex items-center gap-3 py-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm">{r.reason || <span className="text-muted italic">(sans raison)</span>}</div>
                  <div className="text-xs text-muted">/{r.channel_slug} · {r.reporter} · {new Date(r.created_at).toLocaleString('fr-FR')}</div>
                </div>
                {r.resolved ? <Badge tone="success">resolved</Badge> :
                  <button className="btn-ghost" onClick={() => resolve(r)}><Check size={15} /> Resolve</button>}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <h2 className="font-bold mb-4 flex items-center gap-2"><ScrollText size={18} /> Journal d'audit</h2>
        {!audit ? <Spinner className="text-accent" /> : (
          <div className="max-h-96 overflow-auto font-mono text-xs divide-y divide-border">
            {audit.map((a) => (
              <div key={a.id} className="flex gap-3 py-1.5">
                <span className="text-muted whitespace-nowrap">{new Date(a.created_at).toLocaleString('fr-FR')}</span>
                <span className="text-accent whitespace-nowrap">{a.action}</span>
                <span className="text-muted">{a.actor}</span>
                <span className="text-ink/70 truncate">{a.detail}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
