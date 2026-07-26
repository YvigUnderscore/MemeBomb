import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import Layout from './components/Layout.jsx';
import { Spinner } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Channels from './pages/Channels.jsx';
import ChannelDetail from './pages/ChannelDetail.jsx';
import Moderation from './pages/Moderation.jsx';
import Guidelines from './pages/Guidelines.jsx';
import Account from './pages/Account.jsx';
import Admin from './pages/Admin.jsx';
import Profile from './pages/Profile.jsx';
import Hall from './pages/Hall.jsx';
import Components from './pages/Components.jsx';
import NotFound from './pages/NotFound.jsx';

function Protected({ children, staff = false, admin = false, channels = false }) {
  const { user, loading, isStaff, canManageChannels } = useAuth();
  const location = useLocation();
  if (loading) return <div className="min-h-screen grid place-items-center"><Spinner className="w-8 h-8 text-accent" /></div>;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  // Les écrans de channel s'ouvrent aussi aux modérateurs de channel (comptes
  // 'member' promus dans une whitelist) ; les écrans globaux restent au staff.
  if (channels && !canManageChannels) return <Navigate to="/profile" replace />;
  if (staff && !isStaff) return <Navigate to={canManageChannels ? '/channels' : '/profile'} replace />;
  if (admin && user.role !== 'admin') return <Navigate to="/" replace />;
  return <Layout>{children}</Layout>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Protected staff><Dashboard /></Protected>} />
      <Route path="/channels" element={<Protected channels><Channels /></Protected>} />
      <Route path="/channels/:id" element={<Protected channels><ChannelDetail /></Protected>} />
      <Route path="/hall" element={<Protected><Hall /></Protected>} />
      <Route path="/_components" element={<Protected staff><Components /></Protected>} />
      <Route path="/moderation" element={<Protected staff><Moderation /></Protected>} />
      <Route path="/guidelines" element={<Protected staff><Guidelines /></Protected>} />
      <Route path="/account" element={<Protected staff><Account /></Protected>} />
      <Route path="/admin" element={<Protected admin><Admin /></Protected>} />
      <Route path="/profile" element={<Protected><Profile /></Protected>} />
      <Route path="*" element={<Protected><NotFound /></Protected>} />
    </Routes>
  );
}
