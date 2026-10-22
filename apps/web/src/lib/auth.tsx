import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, api } from "./api";
import { HOSTED } from "./hosted";
import type { Me } from "./types";

type Status = "loading" | "in" | "out";

interface AuthValue {
  status: Status;
  me: Me | null;
  /** Reads the session again (after sign in or a settings change). */
  refresh: () => Promise<void>;
  /** Called by any request that got a 401. */
  expire: () => void;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthValue>({
  status: "in",
  me: null,
  refresh: async () => undefined,
  expire: () => undefined,
  signOut: async () => undefined,
});

export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [me, setMe] = useState<Me | null>(null);

  const refresh = useCallback(async () => {
    if (HOSTED) {
      // No API on the static site, so there is no session to look for.
      setMe(null);
      setStatus("out");
      return;
    }
    try {
      setMe(await api.me());
      setStatus("in");
    } catch (e) {
      setMe(null);
      // A 401 means signed out. Any other failure also lands on the sign in page, which can show a message.
      setStatus("out");
      if (!(e instanceof ApiError)) throw e;
    }
  }, []);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      me,
      refresh,
      expire: () => setStatus("out"),
      signOut: async () => {
        await api.logout().catch(() => undefined);
        setMe(null);
        setStatus("out");
      },
    }),
    [status, me, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
