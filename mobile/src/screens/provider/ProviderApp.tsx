import React, { createContext, useCallback, useContext, useState } from "react";

import type { ApiClient } from "../../api/client";
import type { Dashboard } from "../../api/types";
import { DemoSwitcher } from "../../components/DemoSwitcher";
import { TabShell, type TabDef } from "../../components/TabShell";
import { ErrorView, LoadingView } from "../../components/ui";
import { formatDate, formatTime } from "../../lib/format";
import { useRemoteData } from "../../lib/useRemoteData";
import { useSession } from "../../state/session";
import { SettingsModal } from "../SettingsScreen";
import { CustomersScreen } from "./CustomersScreen";
import { ManageScreen } from "./ManageScreen";
import { QrBroadcastScreen } from "./QrBroadcastScreen";
import { QueueScreen } from "./QueueScreen";

type ProviderTab = "queue" | "qr" | "customers" | "manage";

interface ProviderData {
  api: ApiClient;
  dash: Dashboard;
  refreshing: boolean;
  refresh: () => Promise<void>;
  reload: () => Promise<void>;
}

const ProviderDataContext = createContext<ProviderData | null>(null);

export function useProviderData(): ProviderData {
  const ctx = useContext(ProviderDataContext);
  if (!ctx) throw new Error("useProviderData must be used inside ProviderApp");
  return ctx;
}

export function ProviderApp() {
  const { api, demoMode } = useSession();
  const [tab, setTab] = useState<ProviderTab>("queue");
  const [settingsOpen, setSettingsOpen] = useState(false);

  const load = useCallback(() => api.dashboard(), [api]);
  const { data: dash, error, refreshing, refresh, reload } = useRemoteData(load, 20000);

  const left = dash ? dash.lunch_queue.counts.left_to_deliver + dash.dinner_queue.counts.left_to_deliver : 0;
  const tabs: TabDef<ProviderTab>[] = [
    { key: "queue", label: "Deliveries", icon: "bicycle-outline", badge: left },
    { key: "qr", label: "QR & Prompt", icon: "qr-code-outline" },
    { key: "customers", label: "Customers", icon: "people-outline" },
    { key: "manage", label: "Menus & More", icon: "options-outline" },
  ];

  let body: React.ReactNode;
  if (!dash) {
    body = error ? <ErrorView message={error} onRetry={refresh} /> : <LoadingView />;
  } else {
    body = (
      <ProviderDataContext.Provider value={{ api, dash, refreshing, refresh, reload }}>
        {tab === "queue" && <QueueScreen />}
        {tab === "qr" && <QrBroadcastScreen />}
        {tab === "customers" && <CustomersScreen />}
        {tab === "manage" && <ManageScreen />}
      </ProviderDataContext.Provider>
    );
  }

  return (
    <>
      <TabShell
        title="Provider Console"
        subtitle={dash ? `${formatDate(dash.today, true)} · ${formatTime(dash.current_time)}` : undefined}
        tabs={tabs}
        active={tab}
        onChange={setTab}
        onOpenSettings={() => setSettingsOpen(true)}
        headerExtra={demoMode ? <DemoSwitcher /> : null}
      >
        {body}
      </TabShell>
      <SettingsModal visible={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}
