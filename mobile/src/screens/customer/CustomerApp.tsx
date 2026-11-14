import * as Notifications from "expo-notifications";
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Alert, Platform } from "react-native";

import type { ApiClient } from "../../api/client";
import type { CustomerSummary, MealType } from "../../api/types";
import { PLAN_MEALS } from "../../api/types";
import { DemoSwitcher } from "../../components/DemoSwitcher";
import { type MealPrompt, MealPromptModal } from "../../components/MealPromptModal";
import { TabShell, type TabDef } from "../../components/TabShell";
import { ErrorView, LoadingView } from "../../components/ui";
import { titleCase } from "../../lib/format";
import { type MealPromptData, parseMealPrompt, registerForPushToken } from "../../lib/notifications";
import { getItem, setItem } from "../../lib/storage";
import { useRemoteData } from "../../lib/useRemoteData";
import { useSession } from "../../state/session";
import { SettingsModal } from "../SettingsScreen";
import { HistoryScreen } from "./HistoryScreen";
import { HomeScreen } from "./HomeScreen";
import { MenuScreen } from "./MenuScreen";
import { PauseScreen } from "./PauseScreen";
import { ScanScreen } from "./ScanScreen";

const KEY_LAST_HANDLED_PUSH = "dabba.lastHandledPush";

type CustomerTab = "home" | "menu" | "scan" | "pause" | "history";

interface CustomerData {
  customerId: number;
  api: ApiClient;
  summary: CustomerSummary;
  refreshing: boolean;
  refresh: () => Promise<void>;
  reload: () => Promise<void>;
  openPrompt: (meal: MealType) => void;
  goTo: (tab: CustomerTab) => void;
}

const CustomerDataContext = createContext<CustomerData | null>(null);

export function useCustomerData(): CustomerData {
  const ctx = useContext(CustomerDataContext);
  if (!ctx) throw new Error("useCustomerData must be used inside CustomerApp");
  return ctx;
}

const TABS: TabDef<CustomerTab>[] = [
  { key: "home", label: "Home", icon: "home-outline" },
  { key: "menu", label: "Menu", icon: "restaurant-outline" },
  { key: "scan", label: "Scan QR", icon: "qr-code-outline" },
  { key: "pause", label: "Pause", icon: "airplane-outline" },
  { key: "history", label: "History", icon: "time-outline" },
];

export function CustomerApp({ customerId }: { customerId: number }) {
  const { api, demoMode, updateCustomer } = useSession();
  const [tab, setTab] = useState<CustomerTab>("home");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prompt, setPrompt] = useState<MealPrompt | null>(null);
  const [pushStatus, setPushStatus] = useState<string>("Not registered yet");
  const pendingPush = useRef<MealPromptData | null>(null);
  const [pendingTick, setPendingTick] = useState(0);

  const load = useCallback(() => api.customerSummary(customerId), [api, customerId]);
  const { data: summary, error, refreshing, refresh, reload } = useRemoteData(load, 30000);

  // Keep the persisted session's name/boxes in sync with the server.
  useEffect(() => {
    if (summary) {
      const { id, name, phone, address, route_area, boxes_with_customer } = summary.customer;
      updateCustomer({ id, name, phone, address, route_area, boxes_with_customer });
    }
  }, [summary, updateCustomer]);

  const buildPrompt = useCallback(
    (meal: MealType, mealDate?: string, menu?: string, cutoff?: string): MealPrompt => {
      const date = mealDate || summary?.today || "";
      const isToday = !summary || date === summary.today;
      const todayMeal = summary?.today_meals[meal];
      return {
        meal_type: meal,
        meal_date: date,
        menu: menu ?? (isToday ? summary?.menus[meal] ?? "" : ""),
        cutoff: cutoff ?? summary?.cutoffs[meal] ?? "",
        locked: isToday ? todayMeal?.is_locked : false,
        lockReason: isToday ? todayMeal?.lock_reason : undefined,
      };
    },
    [summary],
  );

  const openPrompt = useCallback((meal: MealType) => setPrompt(buildPrompt(meal)), [buildPrompt]);

  const openFromPush = useCallback(
    (data: MealPromptData) => {
      if (data.customer_id && data.customer_id !== customerId) return; // stale token from another account
      setTab("menu");
      setPrompt(buildPrompt(data.meal_type, data.meal_date, data.menu, data.cutoff));
    },
    [buildPrompt, customerId],
  );

  // --- Push registration (once per login) ---
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const reg = await registerForPushToken();
      if (cancelled) return;
      if (reg.token === null) {
        setPushStatus(reg.reason);
        return;
      }
      try {
        await api.registerPushToken(customerId, reg.token);
        if (!cancelled) setPushStatus("Enabled on this phone");
      } catch (err) {
        if (!cancelled) setPushStatus(`Token not saved: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, customerId]);

  // --- Notification listeners: tap (background/cold start) and foreground receipt ---
  useEffect(() => {
    if (Platform.OS === "web") return;
    const handle = (data: unknown) => {
      const parsed = parseMealPrompt(data);
      if (!parsed) return;
      pendingPush.current = parsed; // processed once summary is available
      setPendingTick((n) => n + 1);
    };
    // Cold start from a tapped notification. Remember its id so a later app restart doesn't re-open it.
    (async () => {
      const resp = await Notifications.getLastNotificationResponseAsync();
      if (!resp) return;
      const id = resp.notification.request.identifier;
      if ((await getItem(KEY_LAST_HANDLED_PUSH)) === id) return;
      await setItem(KEY_LAST_HANDLED_PUSH, id);
      handle(resp.notification.request.content.data);
    })().catch(() => undefined);
    const tapSub = Notifications.addNotificationResponseReceivedListener((resp) => {
      void setItem(KEY_LAST_HANDLED_PUSH, resp.notification.request.identifier);
      handle(resp.notification.request.content.data);
    });
    const recvSub = Notifications.addNotificationReceivedListener((n) => handle(n.request.content.data));
    return () => {
      tapSub.remove();
      recvSub.remove();
    };
  }, []);

  useEffect(() => {
    if (summary && pendingPush.current) {
      const data = pendingPush.current;
      pendingPush.current = null;
      void reload();
      openFromPush(data);
    }
  }, [pendingTick, summary, openFromPush, reload]);

  // --- In-app broadcast fallback (works without push, e.g. Expo Go / web) ---
  useEffect(() => {
    if (!summary?.popup_broadcast || !summary.plan) return;
    const stamp = summary.popup_broadcast;
    const key = `dabba.lastBroadcast.${customerId}`;
    (async () => {
      const seen = await getItem(key);
      if (seen === stamp) return;
      await setItem(key, stamp);
      const [meal, at = ""] = stamp.split("|");
      if (meal !== "lunch" && meal !== "dinner") return;
      if (!at.startsWith(summary.today)) return; // ignore yesterday's broadcasts
      if (!summary.plan || !PLAN_MEALS[summary.plan.plan_type].includes(meal)) return;
      const today = summary.today_meals[meal];
      if (!today || today.is_locked || today.status !== "pending") return;
      setPrompt((cur) => cur ?? buildPrompt(meal));
    })();
  }, [summary, customerId, buildPrompt]);

  const answerPrompt = async (p: MealPrompt, wants: boolean) => {
    try {
      const res = await api.respondToMeal(customerId, p.meal_type, wants, p.meal_date || undefined);
      setPrompt(null);
      await reload();
      Alert.alert(
        wants ? `${titleCase(p.meal_type)} confirmed` : `${titleCase(p.meal_type)} cancelled`,
        wants
          ? "Your tiffin is on the way."
          : `No diet will be used. Plan now ends around ${res.estimated_end_date}.`,
      );
    } catch (err) {
      Alert.alert("Could not save", err instanceof Error ? err.message : String(err));
    }
  };

  let body: React.ReactNode;
  if (!summary) {
    body = error ? <ErrorView message={error} onRetry={refresh} /> : <LoadingView />;
  } else {
    const ctx: CustomerData = { customerId, api, summary, refreshing, refresh, reload, openPrompt, goTo: setTab };
    body = (
      <CustomerDataContext.Provider value={ctx}>
        {tab === "home" && <HomeScreen />}
        {tab === "menu" && <MenuScreen />}
        {tab === "scan" && <ScanScreen />}
        {tab === "pause" && <PauseScreen />}
        {tab === "history" && <HistoryScreen />}
      </CustomerDataContext.Provider>
    );
  }

  const pendingCount = summary
    ? Object.values(summary.today_meals).filter((m) => m && m.status === "pending" && !m.is_locked).length
    : 0;

  return (
    <>
      <TabShell
        title={summary ? `Hi, ${summary.customer.name.split(" ")[0]}` : "DabbaTrack"}
        subtitle={summary ? `${summary.customer.route_area} · ${summary.customer.phone}` : undefined}
        tabs={TABS.map((t) => (t.key === "menu" ? { ...t, badge: pendingCount } : t))}
        active={tab}
        onChange={setTab}
        onOpenSettings={() => setSettingsOpen(true)}
        headerExtra={demoMode ? <DemoSwitcher /> : null}
      >
        {body}
      </TabShell>
      <MealPromptModal prompt={prompt} onAnswer={answerPrompt} onDismiss={() => setPrompt(null)} />
      <SettingsModal visible={settingsOpen} onClose={() => setSettingsOpen(false)} pushStatus={pushStatus} />
    </>
  );
}
