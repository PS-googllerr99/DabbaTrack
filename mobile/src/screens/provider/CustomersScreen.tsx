import { Ionicons } from "@expo/vector-icons";
import React, { useMemo, useState } from "react";
import { Alert, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { DashboardCustomer, PlanType } from "../../api/types";
import { PLAN_LABELS } from "../../api/types";
import { Button, Card, Field, Muted, Pill, Row, ScreenScroll, Segmented } from "../../components/ui";
import { formatDate, formatMoney } from "../../lib/format";
import { colors } from "../../theme";
import { useProviderData } from "./ProviderApp";

// Mirrors the server's limits (db.MAX_DIETS / MAX_AMOUNT) so mistakes show before saving.
const MAX_DIETS = 1000;
const MAX_AMOUNT = 1_000_000;

/** Whole number 1..MAX_DIETS, or null. (parseInt would accept "30abc" as 30.) */
function parseDiets(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,4}$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= MAX_DIETS ? n : null;
}

/** Rupees with up to 2 decimals, blank = 0, or null. (parseFloat would read "2,400" as 2.) */
function parseAmount(text: string): number | null {
  const t = text.trim();
  if (!t) return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return n <= MAX_AMOUNT ? n : null;
}

const PLAN_OPTIONS: { value: PlanType; label: string }[] = [
  { value: "lunch_only", label: "Lunch" },
  { value: "dinner_only", label: "Dinner" },
  { value: "both", label: "Both" },
];

export function CustomersScreen() {
  const { dash, refreshing, refresh } = useProviderData();
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [renewing, setRenewing] = useState<DashboardCustomer | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return dash.customers;
    return dash.customers.filter(
      (c) => c.name.toLowerCase().includes(q) || c.phone.includes(q) || c.route_area.toLowerCase().includes(q),
    );
  }, [dash.customers, query]);

  return (
    <>
      <ScreenScroll refreshing={refreshing} onRefresh={refresh}>
        <Row>
          <View style={{ flex: 1 }}>
            <Field label="Search" value={query} onChangeText={setQuery} placeholder="Name, phone or area" autoCorrect={false} />
          </View>
        </Row>
        <Button title="Add customer" icon="person-add" onPress={() => setAdding(true)} />
        <Muted>{filtered.length} active customer(s)</Muted>
        {filtered.map((c) => (
          <CustomerCard
            key={c.id}
            c={c}
            open={expanded === c.id}
            onToggle={() => setExpanded(expanded === c.id ? null : c.id)}
            onRenew={() => setRenewing(c)}
          />
        ))}
      </ScreenScroll>
      <AddCustomerModal visible={adding} onClose={() => setAdding(false)} />
      <RenewModal customer={renewing} onClose={() => setRenewing(null)} />
    </>
  );
}

function CustomerCard({
  c,
  open,
  onToggle,
  onRenew,
}: {
  c: DashboardCustomer;
  open: boolean;
  onToggle: () => void;
  onRenew: () => void;
}) {
  const { api, reload } = useProviderData();
  const [busy, setBusy] = useState(false);
  const low = c.diets_remaining != null && c.diets_remaining <= 3;

  const boxes = async (delta: number) => {
    setBusy(true);
    try {
      await api.adjustBoxes(c.id, delta);
      await reload();
    } catch (err) {
      Alert.alert("Update failed", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // PINs are stored hashed, so the provider can't look one up; they issue a new one instead.
  const resetPin = () =>
    Alert.alert(
      "Reset PIN?",
      `${c.name} gets a new 4-digit PIN. Their old PIN stops working and they're signed out on their phone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset PIN",
          style: "destructive",
          onPress: async () => {
            setBusy(true);
            try {
              const res = await api.resetCustomerPin(c.id);
              Alert.alert("New PIN", `${c.name}'s new PIN is ${res.pin}.\n\nShare it now. It won't be shown again.`);
            } catch (err) {
              Alert.alert("Could not reset PIN", err instanceof Error ? err.message : String(err));
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );

  return (
    <Card style={{ gap: 8 }}>
      <Pressable onPress={onToggle} accessibilityRole="button" accessibilityState={{ expanded: open }}>
        <Row style={{ alignItems: "flex-start" }}>
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>{c.name}</Text>
            <Muted>
              {c.phone} · {c.route_area}
            </Muted>
          </View>
          {c.plan_type ? (
            <Pill
              label={`${c.diets_remaining} left`}
              fg={low ? colors.red : colors.green}
              bg={low ? colors.redSoft : colors.greenSoft}
            />
          ) : (
            <Pill label="No plan" fg={colors.gray} bg={colors.graySoft} />
          )}
          <Ionicons name={open ? "chevron-up" : "chevron-down"} size={18} color={colors.muted} />
        </Row>
      </Pressable>
      {open ? (
        <View style={{ gap: 8 }}>
          <Muted>{c.address}</Muted>
          {c.plan_type ? (
            <Muted>
              {PLAN_LABELS[c.plan_type]} · {c.diets_consumed}/{c.total_diets} used · {formatMoney(c.amount_paid)} paid{" "}
              {formatDate(c.payment_date)} · ends {formatDate(c.estimated_end_date)}
            </Muted>
          ) : null}
          <Muted>{c.boxes_with_customer} empty box(es) with customer</Muted>
          <Button title="Reset PIN" icon="key-outline" small variant="ghost" onPress={resetPin} disabled={busy} />
          <Row>
            <Button title="Renew diets" icon="add-circle" small onPress={onRenew} style={{ flex: 1 }} />
            <Button
              title="Call"
              icon="call"
              small
              variant="ghost"
              onPress={() => Linking.openURL(`tel:${c.phone}`)}
              style={{ flex: 1 }}
            />
          </Row>
          <Row>
            <Button
              title="Box -1"
              icon="remove"
              small
              variant="ghost"
              onPress={() => boxes(-1)}
              disabled={busy || c.boxes_with_customer <= 0}
              style={{ flex: 1 }}
            />
            <Button title="Box +1" icon="add" small variant="ghost" onPress={() => boxes(1)} disabled={busy} style={{ flex: 1 }} />
          </Row>
        </View>
      ) : null}
    </Card>
  );
}

function SheetModal({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={[styles.sheetHeader, { paddingTop: insets.top + 8 }]}>
          <Text style={styles.sheetTitle}>{title}</Text>
          <Pressable onPress={onClose} accessibilityLabel="Close" style={styles.close}>
            <Ionicons name="close" size={24} color={colors.text} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function AddCustomerModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { api, reload, dash } = useProviderData();
  const [form, setForm] = useState({
    name: "",
    phone: "",
    address: "",
    route_area: "",
    plan_type: "both" as PlanType,
    total_diets: "30",
    amount_paid: "",
    pin: "",
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const knownRoutes = useMemo(() => [...new Set(dash.customers.map((c) => c.route_area))], [dash.customers]);

  const submit = async () => {
    const problems: string[] = [];
    if (!form.name.trim()) problems.push("Name is required");
    if (!/^\d{10}$/.test(form.phone.trim())) problems.push("Phone must be 10 digits");
    if (!form.address.trim()) problems.push("Address is required");
    if (form.pin.trim() && !/^\d{4}$/.test(form.pin.trim())) problems.push("PIN must be 4 digits (or leave it blank)");
    const diets = parseDiets(form.total_diets);
    if (diets === null) problems.push(`Diets must be a whole number from 1 to ${MAX_DIETS}`);
    const amountPaid = parseAmount(form.amount_paid);
    if (amountPaid === null) problems.push("Amount must be a number like 2400 or 2400.50 (no commas)");
    if (problems.length || diets === null || amountPaid === null) return Alert.alert("Check the form", problems.join("\n"));

    setBusy(true);
    try {
      const res = await api.addCustomer({
        name: form.name.trim(),
        phone: form.phone.trim(),
        address: form.address.trim(),
        route_area: form.route_area.trim() || "General",
        plan_type: form.plan_type,
        total_diets: diets,
        amount_paid: amountPaid,
        ...(form.pin.trim() ? { pin: form.pin.trim() } : {}),
      });
      await reload();
      Alert.alert(
        "Customer added",
        `${form.name.trim()} can sign in with ${form.phone.trim()} + PIN ${res.pin}.\nShare the PIN now. It won't be shown again.\nPlan ends ${formatDate(res.estimated_end_date, true)}.`,
      );
      setForm((f) => ({ ...f, name: "", phone: "", address: "", amount_paid: "", pin: "" }));
      onClose();
    } catch (err) {
      Alert.alert("Could not add customer", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SheetModal visible={visible} title="Add customer" onClose={onClose}>
      <Field label="Full name" value={form.name} onChangeText={set("name")} placeholder="Aarav Sharma" maxLength={80} />
      <Field
        label="Phone (login)"
        value={form.phone}
        onChangeText={(t) => set("phone")(t.replace(/\D/g, "").slice(0, 10))}
        keyboardType="phone-pad"
        placeholder="9876543210"
      />
      <Field label="Address" value={form.address} onChangeText={set("address")} multiline placeholder="Flat, building, landmark" maxLength={200} />
      <Field
        label="Route area"
        value={form.route_area}
        onChangeText={set("route_area")}
        placeholder="Green Park"
        maxLength={60}
        hint={knownRoutes.length ? `Existing: ${knownRoutes.join(", ")}` : undefined}
      />
      <Text style={styles.label}>Plan</Text>
      <Segmented<PlanType> value={form.plan_type} onChange={(v) => setForm((f) => ({ ...f, plan_type: v }))} options={PLAN_OPTIONS} />
      <View style={{ height: 12 }} />
      <Row>
        <View style={{ flex: 1 }}>
          <Field label="Total diets" value={form.total_diets} onChangeText={set("total_diets")} keyboardType="number-pad" maxLength={4} />
        </View>
        <View style={{ flex: 1 }}>
          <Field label="Amount paid (₹)" value={form.amount_paid} onChangeText={set("amount_paid")} keyboardType="decimal-pad" maxLength={10} />
        </View>
      </Row>
      <Field
        label="Customer PIN (4 digits, optional)"
        value={form.pin}
        onChangeText={(t) => set("pin")(t.replace(/\D/g, "").slice(0, 4))}
        keyboardType="number-pad"
        hint="Leave blank to generate one. Shown once after saving; share it with the customer."
      />
      <Button title="Create customer & plan" icon="checkmark-circle" onPress={submit} loading={busy} />
    </SheetModal>
  );
}

function RenewModal({ customer, onClose }: { customer: DashboardCustomer | null; onClose: () => void }) {
  const { api, reload } = useProviderData();
  const [planType, setPlanType] = useState<PlanType>("both");
  const [diets, setDiets] = useState("30");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  const onShow = () => {
    setPlanType(customer?.plan_type ?? "both");
    setDiets("30");
    setAmount("");
  };

  const submit = async () => {
    if (!customer) return;
    const n = parseDiets(diets);
    if (n === null) return Alert.alert("Check the form", `Diets must be a whole number from 1 to ${MAX_DIETS}`);
    const paid = parseAmount(amount);
    if (paid === null) return Alert.alert("Check the form", "Amount must be a number like 2400 or 2400.50 (no commas)");
    setBusy(true);
    try {
      const res = await api.renew(customer.id, planType, n, paid);
      await reload();
      Alert.alert("Plan renewed", `${customer.name}'s plan now ends ${formatDate(res.estimated_end_date, true)}.`);
      onClose();
    } catch (err) {
      Alert.alert("Renewal failed", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const switching = customer?.plan_type && customer.plan_type !== planType;

  return (
    <Modal visible={!!customer} transparent animationType="fade" onRequestClose={onClose} onShow={onShow}>
      <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.dialog}>
          <Text style={styles.sheetTitle}>Renew · {customer?.name}</Text>
          <Muted style={{ marginBottom: 12 }}>
            Currently {customer?.plan_type ? PLAN_LABELS[customer.plan_type] : "no plan"} · {customer?.diets_remaining ?? 0} diets left
          </Muted>
          <Segmented<PlanType> value={planType} onChange={setPlanType} options={PLAN_OPTIONS} />
          {switching ? (
            <Muted style={{ marginTop: 6, color: colors.red }}>
              Changing plan type starts a new plan; unused diets on the old plan are closed.
            </Muted>
          ) : null}
          <View style={{ height: 12 }} />
          <Row>
            <View style={{ flex: 1 }}>
              <Field label="Diets to add" value={diets} onChangeText={setDiets} keyboardType="number-pad" maxLength={4} />
            </View>
            <View style={{ flex: 1 }}>
              <Field label="Amount (₹)" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" maxLength={10} />
            </View>
          </Row>
          <Row>
            <Button title="Cancel" variant="ghost" onPress={onClose} style={{ flex: 1 }} />
            <Button title="Renew" icon="checkmark" onPress={submit} loading={busy} style={{ flex: 1 }} />
          </Row>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  name: { fontSize: 16, fontWeight: "800", color: colors.text },
  label: { fontSize: 13, fontWeight: "600", color: colors.gray, marginBottom: 6 },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  sheetTitle: { fontSize: 19, fontWeight: "800", color: colors.text },
  close: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: colors.graySoft },
  backdrop: { flex: 1, backgroundColor: "rgba(17,24,39,0.45)", justifyContent: "center", padding: 20 },
  dialog: { backgroundColor: colors.surface, borderRadius: 20, padding: 18 },
});
