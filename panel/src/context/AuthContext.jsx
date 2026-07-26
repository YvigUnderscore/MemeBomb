import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { AuthAPI } from '../lib/api.js';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [discordEnabled, setDiscordEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { user, oauth } = await AuthAPI.me();
      setUser(user);
      setDiscordEnabled(!!oauth?.discordEnabled);
    } catch { setUser(null); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const login = async (u, p) => { const { user } = await AuthAPI.login(u, p); await refresh(); return user; };
  const logout = async () => { await AuthAPI.logout(); setUser(null); };

  // Trois niveaux : admin, staff global (admin + modérateur panel), et
  // modérateur de channel — un compte 'member' promu dans la whitelist d'un
  // channel, qui gère ce channel sans voir les écrans globaux.
  const isAdmin = user?.role === 'admin';
  const isStaff = isAdmin || user?.role === 'moderator';
  const moderatedChannels = user?.moderatedChannels || [];
  const canManageChannels = isStaff || moderatedChannels.length > 0;

  return (
    <AuthCtx.Provider value={{
      user, discordEnabled, loading, login, logout, refresh,
      isAdmin, isStaff, moderatedChannels, canManageChannels,
    }}>
      {children}
    </AuthCtx.Provider>
  );
}
