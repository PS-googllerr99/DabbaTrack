import Constants from "expo-constants";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { ApiClient, normalizeBaseUrl } from "../api/client";
import type { CustomerIdentity } from "../api/types";
import { getItem, getJson, removeItem, setItem, setJson } from "../lib/storage";

const KEY_BASE_URL = "dabba.baseUrl";
const KEY_SESSION = "dabba.session";
const KEY_DEMO = "dabba.demoMode";

/** `token` is the server-issued bearer token; sessions saved before tokens existed are discarded. */
export type Session = { role: "customer"; customer: CustomerIdentity; token: string } | { role: "provider"; token: string };

interface SessionContextValue {
  ready: boolean;
  baseUrl: string;
  api: ApiClient;
  session: Session | null;
  demoMode: boolean;
  setBaseUrl: (url: string) => Promise<void>;
  setDemoMode: (on: boolean) => Promise<void>;
  loginCustomer: (phone: string, pin: string) => Promise<CustomerIdentity>;
  loginProvider: (pin: string) => Promise<void>;
  logout: () => Promise<void>;
  updateCustomer: (patch: Partial<CustomerIdentity>) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * Pick a sensible default API URL:
 * 1. EXPO_PUBLIC_API_URL (set in .env or the EAS build profile)
 * 2. the LAN IP of the machine running `expo start` (dev only), on port 8080
 * 3. localhost:8080
 */
export function defaultBaseUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  if (fromEnv) return normalizeBaseUrl(fromEnv);
  const hostUri = Constants.expoConfig?.hostUri; // e.g. "192.168.1.20:8081"
  const host = hostUri?.split(":")[0];
  if (host) return `http://${host}:8080`;
  return "http://localhost:8080";
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [baseUrl, setBaseUrlState] = useState(defaultBaseUrl());
  const [session, setSession] = useState<Session | null>(null);
  const [demoMode, setDemoModeState] = useState(false);

  useEffect(() => {
    (async () => {
      const [savedUrl, savedSession, savedDemo] = await Promise.all([
        getItem(KEY_BASE_URL),
        getJson<Session>(KEY_SESSION),
        getItem(KEY_DEMO),
      ]);
      if (savedUrl) setBaseUrlState(savedUrl);
      if (
        savedSession &&
        (savedSession.role === "provider" || savedSession.role === "customer") &&
        typeof savedSession.token === "string" &&
        savedSession.token
      ) {
        setSession(savedSession);
      } else if (savedSession) {
        await removeItem(KEY_SESSION); // pre-token session: sign in again
      }
      setDemoModeState(savedDemo === "1");
      setReady(true);
    })();
  }, []);

  const persistSession = useCallback(async (next: Session | null) => {
    setSession(next);
    if (next) await setJson(KEY_SESSION, next);
    else await removeItem(KEY_SESSION);
  }, []);

  // The server rejected our token (expired, revoked, or PIN reset): go back to the sign-in screen.
  const token = session?.token ?? null;
  const onUnauthorized = useCallback(() => {
    void persistSession(null);
  }, [persistSession]);
  const api = useMemo(() => new ApiClient(baseUrl, token, onUnauthorized), [baseUrl, token, onUnauthorized]);

  const setBaseUrl = useCallback(async (url: string) => {
    const clean = normalizeBaseUrl(url);
    if (!clean) throw new Error("Base URL cannot be empty");
    setBaseUrlState(clean);
    await setItem(KEY_BASE_URL, clean);
  }, []);

  const setDemoMode = useCallback(async (on: boolean) => {
    setDemoModeState(on);
    await setItem(KEY_DEMO, on ? "1" : "0");
  }, []);

  const loginCustomer = useCallback(
    async (phone: string, pin: string) => {
      const res = await api.customerLogin(phone.trim(), pin.trim());
      await persistSession({ role: "customer", customer: res.customer, token: res.token });
      return res.customer;
    },
    [api, persistSession],
  );

  const loginProvider = useCallback(
    async (pin: string) => {
      const res = await api.providerLogin(pin.trim());
      await persistSession({ role: "provider", token: res.token });
    },
    [api, persistSession],
  );

  const logout = useCallback(async () => {
    // `api` still carries the old token here. Stop meal prompts to this phone, then revoke the token on
    // the server; ignore network failures so sign-out always works offline.
    const signedIn = api;
    const customerId = session?.role === "customer" ? session.customer.id : null;
    await persistSession(null);
    void (async () => {
      if (customerId !== null) await signedIn.registerPushToken(customerId, null).catch(() => undefined);
      await signedIn.logout().catch(() => undefined);
    })();
  }, [api, persistSession, session]);

  const updateCustomer = useCallback(
    (patch: Partial<CustomerIdentity>) => {
      if (session?.role !== "customer") return;
      const merged = { ...session.customer, ...patch };
      if (JSON.stringify(merged) === JSON.stringify(session.customer)) return;
      void persistSession({ ...session, customer: merged });
    },
    [persistSession, session],
  );

  const value: SessionContextValue = {
    ready,
    baseUrl,
    api,
    session,
    demoMode,
    setBaseUrl,
    setDemoMode,
    loginCustomer,
    loginProvider,
    logout,
    updateCustomer,
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}
