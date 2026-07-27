import { useState } from 'react';
import { Save, RotateCcw, Trash2, ScrollText, ToggleRight, PartyPopper, Info } from 'lucide-react';
import { ChannelAPI } from '../../lib/api.js';
import { Card, Toggle, Spinner, Tooltip } from '../../components/ui.jsx';
import { useToast } from '../../components/Toast.jsx';
import { useConfirm } from '../../components/Confirm.jsx';

export const FEATURE_LABELS = {
  video: 'Videos / GIFs', audio: 'Sounds (audio media)', sounds: 'Custom sounds (on appear)',
  schedule: 'Scheduling', multiElement: 'Multi-layer editor (image/drawing)',
  chooseBig: 'Allow large sizes', choosePosition: 'Pick the on-screen position',
  shareSettings: 'Share settings between members',
  presence: 'See who is online (editor)',
};

const MEDIA_TYPES = [
  { id: 'image', label: 'Images' },
  { id: 'gif', label: 'GIF' },
  { id: 'video', label: 'Videos' },
  { id: 'audio', label: 'Sounds' },
];

function Num({ label, value, onChange, min, max, step = 1, suffix }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <div className="flex items-center gap-2">
        <input type="number" className="input" value={value} min={min} max={max} step={step}
          onChange={(e) => onChange(Number(e.target.value))} />
        {suffix && <span className="text-xs text-muted whitespace-nowrap">{suffix}</span>}
      </div>
    </label>
  );
}

export default function SettingsTab({ channel, onSaved }) {
  const [s, setS] = useState(channel.settings);
  // Texte brut des paliers : parsé seulement à l'enregistrement, sinon un input
  // contrôlé re-parsé à chaque frappe « mange » les virgules et les espaces.
  const [milestonesText, setMilestonesText] = useState((channel.settings.reactionMilestones || []).join(', '));
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();
  const set = (k, v) => setS((prev) => ({ ...prev, [k]: v }));

  const parseMilestones = (txt) => [...new Set(
    txt.split(',').map((n) => parseInt(n.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0),
  )].sort((a, b) => a - b);

  const toggleType = (id) => {
    const has = s.allowedTypes.includes(id);
    const next = has ? s.allowedTypes.filter((t) => t !== id) : [...s.allowedTypes, id];
    if (next.length === 0) return;
    set('allowedTypes', next);
  };

  const save = async () => {
    setBusy(true);
    try {
      const payload = {
        ...s,
        bannedWords: (s.bannedWords || []).map((w) => w.trim()).filter(Boolean),
        reactionMilestones: parseMilestones(milestonesText),
      };
      await ChannelAPI.saveSettings(channel.id, payload);
      toast.success('Settings saved');
      onSaved?.();
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };

  const purge = async () => {
    if (!(await confirm({ title: 'Danger zone', message: `PERMANENTLY delete all history of "${channel.name}" (media included)?`, danger: true, confirmLabel: 'Delete everything' }))) return;
    try { const r = await ChannelAPI.purge(channel.id); toast.success(`${r.deleted} meme(s) deleted`); }
    catch (e) { toast.error(e.message); }
  };

  const bannedText = Array.isArray(s.bannedWords) ? s.bannedWords.join('\n') : '';

  return (
    <div className="space-y-5">
      <div className="grid lg:grid-cols-2 gap-5">
        <Card>
          <h3 className="font-bold mb-4">Media limits</h3>
          <div className="grid grid-cols-2 gap-4">
            <Num label="Max size" value={s.maxUploadMb} onChange={(v) => set('maxUploadMb', v)} min={1} max={200} suffix="MB" />
            <Num label="Max text" value={s.maxTextLength} onChange={(v) => set('maxTextLength', v)} min={1} max={1000} suffix="chars" />
            <Num label="Video duration" value={s.maxVideoDurationS} onChange={(v) => set('maxVideoDurationS', v)} min={1} max={120} suffix="s" />
            <Num label="Sound duration" value={s.maxAudioDurationS} onChange={(v) => set('maxAudioDurationS', v)} min={1} max={120} suffix="s" />
            <Num label="Image duration" value={s.maxImageDurationS} onChange={(v) => set('maxImageDurationS', v)} min={1} max={60} suffix="s" />
            <Num label="GIF duration" value={s.maxGifDurationS} onChange={(v) => set('maxGifDurationS', v)} min={1} max={60} suffix="s" />
          </div>
          <div className="mt-4">
            <span className="label">Allowed types</span>
            <div className="flex flex-wrap gap-2">
              {MEDIA_TYPES.map((t) => (
                <button key={t.id} onClick={() => toggleType(t.id)}
                  className={`chip border transition ${s.allowedTypes.includes(t.id)
                    ? 'bg-accent/15 text-accent border-accent/40' : 'bg-surface-2 text-muted border-border'}`}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </Card>

        <Card>
          <h3 className="font-bold mb-4 flex items-center gap-1.5">Client defaults
            <Tooltip label="Settings pushed to clients on pairing. Each user can adjust them locally; these are starting values."><Info size={14} className="text-muted" /></Tooltip>
          </h3>
          <div className="grid grid-cols-2 gap-4">
            <Num label="Cooldown" value={s.defaultCooldownS} onChange={(v) => set('defaultCooldownS', v)} min={0} max={600} suffix="s" />
            <Num label="Max sends / sender" value={s.rateLimitPerMinute} onChange={(v) => set('rateLimitPerMinute', v)} min={0} max={120} suffix="/min" />
            <Num label="Max receives / recipient" value={s.maxReceivesPerMinute ?? 20} onChange={(v) => set('maxReceivesPerMinute', v)} min={0} max={240} suffix="/min" />
            <Num label="Send warmup after app launch (0 = off)" value={s.senderWarmupS ?? 0} onChange={(v) => set('senderWarmupS', v)} min={0} max={3600} suffix="s" />
          </div>
          <label className="block mt-4">
            <span className="label">Default volume ({Math.round(s.defaultVolume * 100)}%)</span>
            <input type="range" min={0} max={1} step={0.05} value={s.defaultVolume}
              onChange={(e) => set('defaultVolume', Number(e.target.value))} className="w-full accent-accent" />
          </label>
          <label className="block mt-2">
            <span className="label">Default opacity ({Math.round(s.defaultOpacity * 100)}%)</span>
            <input type="range" min={0.1} max={1} step={0.05} value={s.defaultOpacity}
              onChange={(e) => set('defaultOpacity', Number(e.target.value))} className="w-full accent-accent" />
          </label>
          <div className="mt-3 divide-y divide-border">
            <Toggle label="Sending from the editor" hint="Allow clients to create memes outside Discord."
              checked={s.allowEditorSend} onChange={(v) => set('allowEditorSend', v)} />
          </div>
        </Card>
      </div>

      <Card>
        <h3 className="font-bold mb-4">Moderation</h3>
        <div className="grid lg:grid-cols-2 gap-5">
          <div>
            <label className="block">
              <span className="label">Moderation mode</span>
              <select className="input" value={s.moderationMode} onChange={(e) => set('moderationMode', e.target.value)}>
                <option value="off">Disabled</option>
                <option value="filter">Automatic filter (recommended)</option>
                <option value="review">Filter + manual review</option>
              </select>
            </label>
            <div className="mt-3 divide-y divide-border">
              <Toggle label="Guidelines acceptance required" hint="Clients must accept the guidelines before sending."
                checked={s.requireGuidelinesAccept} onChange={(v) => set('requireGuidelinesAccept', v)} />
            </div>
          </div>
          <label className="block">
            <span className="label">Banned words/phrases (one per line)</span>
            <textarea className="input min-h-[140px] font-mono text-xs"
              value={bannedText}
              onChange={(e) => set('bannedWords', e.target.value.split('\n'))}
              placeholder={'bannedword\nanother phrase'} />
            <span className="text-xs text-muted mt-1 block">
              On top of the base list. Normalization (accents, leetspeak, spacing) is automatic.
            </span>
          </label>
        </div>
      </Card>

      <Card>
        <h3 className="font-bold mb-4 flex items-center gap-2"><ToggleRight size={18} /> Features & limits</h3>
        <p className="text-sm text-muted mb-3">Channel defaults. They can be overridden per group (Groups tab) or per member (Whitelist tab).</p>
        <div className="grid md:grid-cols-2 gap-x-6 divide-y divide-border md:divide-y-0">
          {Object.entries(FEATURE_LABELS).map(([k, label]) => (
            <Toggle key={k} label={label} checked={(s.features || {})[k] !== false}
              onChange={(v) => set('features', { ...(s.features || {}), [k]: v })} />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-4 mt-4">
          <Num label="Storage quota / user" value={s.storageQuotaMb} onChange={(v) => set('storageQuotaMb', v)} min={0} max={10000} suffix="MB" />
          <Num label="Schedules / user" value={s.maxSchedulesPerUser} onChange={(v) => set('maxSchedulesPerUser', v)} min={0} max={1000} suffix="max" />
        </div>
      </Card>

      <Card>
        <h3 className="font-bold mb-4 flex items-center gap-2"><PartyPopper size={18} /> Reactions & vibes</h3>
        <div className="divide-y divide-border">
          <Toggle label="Shared channel soundboard" hint="Members can use the sounds curated by moderators (Soundboard tab)."
            checked={s.sharedSoundboard !== false} onChange={(v) => set('sharedSoundboard', v)} />
          <Toggle label="Reaction milestone effects" hint="Confetti + sound on every screen when a meme crosses a reaction milestone."
            checked={s.celebrateEffects !== false} onChange={(v) => set('celebrateEffects', v)} />
        </div>
        <label className="block mt-4">
          <span className="label">Reaction milestones (comma-separated numbers)</span>
          <input className="input font-mono" value={milestonesText}
            onChange={(e) => setMilestonesText(e.target.value)}
            onBlur={() => setMilestonesText(parseMilestones(milestonesText).join(', '))}
            placeholder="5, 10, 25" />
          <span className="text-xs text-muted mt-1 block">An effect fires at each milestone reached (once per meme).</span>
        </label>
      </Card>

      <Card>
        <h3 className="font-bold mb-4 flex items-center gap-2"><ScrollText size={18} /> This channel's guidelines</h3>
        <textarea className="input min-h-[120px] font-mono text-xs"
          value={s.guidelines || ''}
          onChange={(e) => set('guidelines', e.target.value)}
          placeholder="Leave empty to use the global guidelines. Otherwise this text replaces the rules for THIS channel (simple markdown)." />
        <span className="text-xs text-muted mt-1 block">Empty = global guidelines (Guidelines page). Filled = override for this channel.</span>
      </Card>

      <Card>
        <h3 className="font-bold mb-2 flex items-center gap-2 text-danger"><Trash2 size={18} /> Danger zone</h3>
        <p className="text-sm text-muted mb-3">Deletes this channel's entire meme history (media included). Irreversible.</p>
        <button className="btn-danger" onClick={purge}>Delete the channel's entire history</button>
      </Card>

      <div className="flex justify-end gap-2 sticky bottom-4">
        <button className="btn-ghost" onClick={() => { setS(channel.settings); setMilestonesText((channel.settings.reactionMilestones || []).join(', ')); }}><RotateCcw size={16} /> Reset</button>
        <button className="btn-primary" disabled={busy} onClick={save}>{busy ? <Spinner /> : <Save size={16} />} Save</button>
      </div>
    </div>
  );
}
