import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { DemoCustomer, DemoInfo } from "../api/types";
import { PLAN_LABELS } from "../api/types";
import { Banner, Button, Card, Field, Muted, Segmented } from "../components/ui";
import { useSession } from "../state/session";
import { colors } from "../theme";

type Role = "customer" | "provider";

export function LaunchScreen({ onOpenSettings }: { onOpenSettings: () => void }) {
  const insets = useSafeAreaInsets();
  const { api, baseUrl, loginCustomer, loginProvider, setDemoMode } = useSession();
  const [role, setRole] = useState<Role>("customer");
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [providerPin, setProviderPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [demoOpen, setDemoOpen] = useState(false);
  // Demo Mode is only offered when the server says it runs with DEMO_MODE=1.
  const [demo, setDemo] = useState<DemoInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDemo(null);
    api
      .demoInfo()
      .then((info) => !cancelled && setDemo(info))
      .catch(() => !cancelled && setDemo({ enabled: false }));
    return () => {
      cancelled = true;
    };
  }, [api]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submitCustomer = () => {
    if (!/^\d{10}$/.test(phone.trim())) return setError("Enter your 10-digit phone number");
    if (!/^\d{4}$/.test(pin.trim())) return setError("PIN must be 4 digits");
    void run(async () => {
      await setDemoMode(false);
      await loginCustomer(phone, pin);
    });
  };

  const submitProvider = () => {
    if (!providerPin.trim()) return setError("Enter the provider PIN");
    void run(async () => {
      await setDemoMode(false);
      await loginProvider(providerPin);
    });
  };

  const demoAsCustomer = (c: DemoCustomer) =>
    run(async () => {
      await setDemoMode(true);
      await loginCustomer(c.phone, c.pin);
    });

  // Uses the PIN typed in the Provider tab if any, else the demo server's PIN. The server still verifies it.
  const demoAsProvider = () =>
    run(async () => {
      const pinToUse = providerPin.trim() || demo?.provider_pin;
      if (!pinToUse) throw new Error("Type the provider PIN in the Provider tab first.");
      await setDemoMode(true);
      await loginProvider(pinToUse);
    });

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView
        contentContainerStyle={[styles.container, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.brandRow}>
          <View style={styles.logo}>
            <Ionicons name="fast-food" size={30} color="#fff" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.brand}>DabbaTrack</Text>
            <Muted>Tiffin plans, meal confirmations & QR delivery</Muted>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Server settings" onPress={onOpenSettings} style={styles.gear}>
            <Ionicons name="settings-outline" size={22} color={colors.primaryDark} />
          </Pressable>
        </View>

        <Segmented<Role>
          value={role}
          onChange={(r) => {
            setRole(r);
            setError(null);
          }}
          options={[
            { value: "customer", label: "Customer" },
            { value: "provider", label: "Provider" },
          ]}
        />

        <Card>
          {role === "customer" ? (
            <>
              <Text style={styles.cardTitle}>Sign in to your tiffin plan</Text>
              <Field
                label="Phone number"
                value={phone}
                onChangeText={(t) => setPhone(t.replace(/\D/g, "").slice(0, 10))}
                keyboardType="phone-pad"
                placeholder="98765 43210"
                autoComplete="tel"
                textContentType="telephoneNumber"
              />
              <Field
                label="4-digit PIN"
                value={pin}
                onChangeText={(t) => setPin(t.replace(/\D/g, "").slice(0, 4))}
                keyboardType="number-pad"
                secureTextEntry
                placeholder="••••"
                hint="Your PIN is set by your tiffin provider."
                onSubmitEditing={submitCustomer}
              />
              <Button title="Sign in" icon="log-in-outline" onPress={submitCustomer} loading={busy} />
            </>
          ) : (
            <>
              <Text style={styles.cardTitle}>Provider console</Text>
              <Field
                label="Provider PIN"
                value={providerPin}
                onChangeText={(t) => setProviderPin(t.replace(/\D/g, "").slice(0, 8))}
                keyboardType="number-pad"
                secureTextEntry
                placeholder="••••"
                hint="The PIN your server was set up with. You can change it in Settings."
                onSubmitEditing={submitProvider}
              />
              <Button title="Open provider console" icon="storefront-outline" onPress={submitProvider} loading={busy} />
            </>
          )}
        </Card>

        {error ? <Banner tone="red" icon="alert-circle" text={error} /> : null}

        {demo?.enabled ? (
        <Card warm>
          <View style={styles.demoHead}>
            <Ionicons name="sparkles" size={18} color={colors.primaryDark} />
            <Text style={[styles.cardTitle, { marginBottom: 0, flex: 1 }]}>Demo Mode</Text>
          </View>
          <Muted style={{ marginVertical: 8 }}>
            This server is running in demo mode. One-tap sign in as a demo customer or the provider. Adds a quick role
            switcher to the header.
          </Muted>
          {!demoOpen ? (
            <Button title="Start demo" variant="soft" icon="play" onPress={() => setDemoOpen(true)} />
          ) : (
            <View style={{ gap: 8 }}>
              <Button title="Provider console" variant="primary" icon="storefront" onPress={demoAsProvider} disabled={busy} />
              {(demo.customers ?? []).map((c) => (
                <Pressable key={c.id} onPress={() => demoAsCustomer(c)} disabled={busy} style={styles.demoRow}>
                  <Ionicons name="person-circle" size={30} color={colors.primary} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.demoName}>{c.name}</Text>
                    <Muted>
                      {c.plan_type ? PLAN_LABELS[c.plan_type] : "No plan"} · {c.route_area}
                    </Muted>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={colors.muted} />
                </Pressable>
              ))}
            </View>
          )}
        </Card>
        ) : null}

        <Muted style={{ textAlign: "center" }}>Server: {baseUrl}</Muted>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 16 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 4 },
  logo: {
    width: 54,
    height: 54,
    borderRadius: 16,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  brand: { fontSize: 26, fontWeight: "800", color: colors.text },
  gear: { width: 42, height: 42, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: colors.primarySoft },
  cardTitle: { fontSize: 17, fontWeight: "700", color: colors.text, marginBottom: 12 },
  demoHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  demoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 10,
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  demoName: { fontSize: 15, fontWeight: "700", color: colors.text },
});
