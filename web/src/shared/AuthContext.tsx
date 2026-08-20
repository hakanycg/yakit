import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "./api";
import { setCurrentStationId } from "./stationScope";
import type { CurrentUser } from "./types";

export interface LoginResult {
  requiresTotp: boolean;
  challengeToken?: string;
}

interface AuthState {
  user: CurrentUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<LoginResult>;
  loginWithTotp: (challengeToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<{ user: CurrentUser }>("/api/auth/me");
      setUser(res.user);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
      } else {
        throw err;
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async (username: string, password: string): Promise<LoginResult> => {
    const res = await api.post<{ user?: CurrentUser; requiresTotp?: boolean; challengeToken?: string }>("/api/auth/login", {
      username,
      password,
    });
    if (res.requiresTotp) {
      return { requiresTotp: true, challengeToken: res.challengeToken };
    }
    await refresh();
    return { requiresTotp: false };
  }, [refresh]);

  const loginWithTotp = useCallback(async (challengeToken: string, code: string) => {
    await api.post("/api/auth/login/totp", { challengeToken, code });
    await refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    await api.post("/api/auth/logout");
    setUser(null);
    setCurrentStationId(null);
  }, []);

  return <AuthContext.Provider value={{ user, loading, login, loginWithTotp, logout, refresh }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth, AuthProvider icinde kullanilmalidir.");
  return ctx;
}
