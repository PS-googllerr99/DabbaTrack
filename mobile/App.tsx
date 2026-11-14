import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { LoadingView } from "./src/components/ui";
import { configureNotificationHandler } from "./src/lib/notifications";
import { CustomerApp } from "./src/screens/customer/CustomerApp";
import { LaunchScreen } from "./src/screens/LaunchScreen";
import { ProviderApp } from "./src/screens/provider/ProviderApp";
import { SettingsModal } from "./src/screens/SettingsScreen";
import { SessionProvider, useSession } from "./src/state/session";

configureNotificationHandler();

function Root() {
  const { ready, session } = useSession();
  const [settingsOpen, setSettingsOpen] = useState(false);

  if (!ready) return <LoadingView label="Starting DabbaTrack…" />;

  if (session?.role === "customer") {
    // key: remount everything (listeners, push registration) when switching accounts in demo mode
    return <CustomerApp key={`customer-${session.customer.id}`} customerId={session.customer.id} />;
  }
  if (session?.role === "provider") return <ProviderApp key="provider" />;

  return (
    <>
      <LaunchScreen onOpenSettings={() => setSettingsOpen(true)} />
      <SettingsModal visible={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <StatusBar style="dark" />
        <Root />
      </SessionProvider>
    </SafeAreaProvider>
  );
}
