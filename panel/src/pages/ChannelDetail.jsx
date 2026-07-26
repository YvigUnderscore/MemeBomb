import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Wand2, SlidersHorizontal, Users, Boxes, MonitorSmartphone, History, Bot,
  ArrowLeft, Trash2, BarChart3, Music,
} from 'lucide-react';
import { ChannelAPI } from '../lib/api.js';
import { Spinner, Badge } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';
import { useConfirm } from '../components/Confirm.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import EditorTab from './channel/EditorTab.jsx';
import SettingsTab from './channel/SettingsTab.jsx';
import WhitelistTab from './channel/WhitelistTab.jsx';
import GroupsTab from './channel/GroupsTab.jsx';
import DevicesTab from './channel/DevicesTab.jsx';
import HistoryTab from './channel/HistoryTab.jsx';
import StatsTab from './channel/StatsTab.jsx';
import SoundboardTab from './channel/SoundboardTab.jsx';
import DiscordTab from './channel/DiscordTab.jsx';

// `staff: true` = réservé au staff global (admin / modérateur panel). Les
// autres onglets forment le panel du modérateur de channel.
const TABS = [
  { id: 'send', label: 'Editor', icon: Wand2, staff: true },
  { id: 'settings', label: 'Settings', icon: SlidersHorizontal },
  { id: 'whitelist', label: 'Whitelist', icon: Users },
  { id: 'groups', label: 'Groups', icon: Boxes },
  { id: 'devices', label: 'Devices', icon: MonitorSmartphone },
  { id: 'soundboard', label: 'Soundboard', icon: Music },
  { id: 'history', label: 'History', icon: History },
  { id: 'stats', label: 'Stats', icon: BarChart3, staff: true },
  { id: 'discord', label: 'Discord', icon: Bot },
];

export default function ChannelDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { isAdmin, isStaff } = useAuth();
  const [channel, setChannel] = useState(null);
  const [tab, setTab] = useState(isStaff ? 'send' : 'whitelist');

  const reload = () => ChannelAPI.get(id).then(setChannel).catch((e) => toast.error(e.message));
  useEffect(() => { reload(); }, [id]);

  if (!channel) return <div className="grid place-items-center h-64"><Spinner className="w-7 h-7 text-accent" /></div>;

  const deleteChannel = async () => {
    if (!(await confirm({ message: `Delete the channel "${channel.name}" and ALL its data (memes, whitelist, devices)?`, danger: true, confirmLabel: 'Delete channel' }))) return;
    try { await ChannelAPI.remove(id); toast.success('Channel deleted'); navigate('/channels'); }
    catch (e) { toast.error(e.message); }
  };

  const tabs = TABS.filter((t) => !t.staff || isStaff);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/channels')} className="btn-ghost !px-2.5"><ArrowLeft size={18} /></button>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-extrabold">{channel.name}</h1>
            {!channel.active && <Badge tone="danger">inactive</Badge>}
            <Badge tone={channel.online > 0 ? 'success' : 'default'}>{channel.online} online</Badge>
          </div>
          <div className="text-xs text-muted">/{channel.slug}</div>
        </div>
        {isAdmin && <button onClick={deleteChannel} className="btn-danger"><Trash2 size={16} /> Delete</button>}
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-border pb-px">
        {tabs.map(({ id: tid, label, icon: Icon }) => (
          <button
            key={tid}
            onClick={() => setTab(tid)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-t-lg border-b-2 -mb-px transition whitespace-nowrap
              ${tab === tid ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink'}`}
          >
            <Icon size={16} /> {label}
          </button>
        ))}
      </div>

      <div>
        {tab === 'send' && isStaff && <EditorTab channel={channel} />}
        {tab === 'settings' && <SettingsTab channel={channel} onSaved={reload} />}
        {tab === 'whitelist' && <WhitelistTab channel={channel} />}
        {tab === 'groups' && <GroupsTab channel={channel} />}
        {tab === 'devices' && <DevicesTab channel={channel} />}
        {tab === 'soundboard' && <SoundboardTab channel={channel} />}
        {tab === 'history' && <HistoryTab channel={channel} />}
        {tab === 'stats' && isStaff && <StatsTab channel={channel} />}
        {tab === 'discord' && <DiscordTab channel={channel} onSaved={reload} />}
      </div>
    </div>
  );
}
