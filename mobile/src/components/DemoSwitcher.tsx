import { Ionicons } from "@expo/vector-icons";
import React, { useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import type { DemoCustomer } from "../api/types";
import { PLAN_LABELS } from "../api/types";
import { useSession } from "../state/session";
import { colors } from "../theme";
import { Muted } from "./ui";

/** Header pill (Demo Mode only) to jump between provider and customer accounts while pitching. */
export function DemoSwitcher() {
  const { api, session, loginCustomer, loginProvider } = useSession();
  const [open, setOpen] = useState(false);
  const [customers, setCustomers] = useState<DemoCustomer[] | null>(null);
  const [providerPin, setProviderPin] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const show = async () => {
    setOpen(true);
    try {
      const info = await api.demoInfo();
      if (!info.enabled) throw new Error("This server is not running in demo mode.");
      setCustomers(info.customers ?? []);
      setProviderPin(info.provider_pin ?? null);
    } catch (err) {
      setOpen(false);
      Alert.alert("Demo switcher", err instanceof Error ? err.message : String(err));
    }
  };

  const pick = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setOpen(false);
    } catch (err) {
      Alert.alert("Could not switch", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const currentId = session?.role === "customer" ? session.customer.id : null;

  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel="Switch demo role" onPress={show} style={styles.pill}>
        <Ionicons name="swap-horizontal" size={16} color={colors.purple} />
        <Text style={styles.pillText}>Demo</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => undefined}>
            <Text style={styles.title}>Switch demo role</Text>
            {!customers ? (
              <ActivityIndicator color={colors.primary} style={{ marginVertical: 20 }} />
            ) : (
              <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ gap: 8 }}>
                {providerPin ? (
                  <Row
                    icon="storefront"
                    title="Provider console"
                    sub={`Demo PIN ${providerPin}`}
                    active={session?.role === "provider"}
                    disabled={busy}
                    onPress={() => pick(() => loginProvider(providerPin))}
                  />
                ) : null}
                {customers.map((c) => (
                  <Row
                    key={c.id}
                    icon="person-circle"
                    title={c.name}
                    sub={`${c.plan_type ? PLAN_LABELS[c.plan_type] : "No plan"} · ${c.route_area}`}
                    active={c.id === currentId}
                    disabled={busy}
                    onPress={() => pick(() => loginCustomer(c.phone, c.pin))}
                  />
                ))}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function Row({
  icon,
  title,
  sub,
  active,
  disabled,
  onPress,
}: {
  icon: React.ComponentProps<typeof Ionicons>["name"];
  title: string;
  sub: string;
  active: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} disabled={disabled || active} style={[styles.row, active && styles.rowActive]}>
      <Ionicons name={icon} size={28} color={colors.primary} />
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Muted>{sub}</Muted>
      </View>
      {active ? <Text style={styles.current}>Current</Text> : <Ionicons name="chevron-forward" size={18} color={colors.muted} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    height: 40,
    borderRadius: 12,
    backgroundColor: colors.purpleSoft,
  },
  pillText: { color: colors.purple, fontWeight: "700", fontSize: 13 },
  backdrop: { flex: 1, backgroundColor: "rgba(17,24,39,0.45)", justifyContent: "center", padding: 20 },
  sheet: { backgroundColor: colors.surface, borderRadius: 20, padding: 16 },
  title: { fontSize: 18, fontWeight: "800", color: colors.text, marginBottom: 12 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowActive: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  rowTitle: { fontSize: 15, fontWeight: "700", color: colors.text },
  current: { fontSize: 12, fontWeight: "700", color: colors.primaryDark },
});
