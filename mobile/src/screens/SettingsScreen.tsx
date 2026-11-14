import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import { useState } from "react";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ApiClient, normalizeBaseUrl } from "../api/client";
import { Banner, Button, Card, Field, Muted, SectionTitle } from "../components/ui";
import { defaultBaseUrl, useSession } from "../state/session";
import { colors } from "../theme";

export function SettingsModal({
  visible,
  onClose,
  pushStatus,
}: {
  visible: boolean;
  onClose: () => void;
  /** Customer only: result of push registration, shown for troubleshooting. */
  pushStatus?: string;
}) {
  const insets = useSafeAreaInsets();
  const { baseUrl, setBaseUrl, session, logout, demoMode, setDemoMode, api } = useSession();
  const [draftUrl, setDraftUrl] = useState(baseUrl);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const [curPin, setCurPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [pinBusy, setPinBusy] = useState(false);

  const testConnection = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      const res = await new ApiClient(draftUrl).health();
      setTestMsg({ ok: true, text: `Connected · server time ${res.time.replace("T", " ")}` });
    } catch (err) {
      setTestMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    try {
      await setBaseUrl(draftUrl);
      setDraftUrl(normalizeBaseUrl(draftUrl));
      setTestMsg({ ok: true, text: "Saved" });
    } catch (err) {
      setTestMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  };

  const changePin = async () => {
    if (!/^\d{4,8}$/.test(newPin)) return Alert.alert("Invalid PIN", "Provider PIN must be 4–8 digits.");
    setPinBusy(true);
    try {
      await api.changeProviderPin(curPin, newPin);
      setCurPin("");
      setNewPin("");
      Alert.alert("PIN updated", "Use the new PIN next time you sign in.");
    } catch (err) {
      Alert.alert("Could not change PIN", err instanceof Error ? err.message : String(err));
    } finally {
      setPinBusy(false);
    }
  };

  const confirmLogout = () =>
    Alert.alert("Sign out?", "You'll return to the role selection screen.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: async () => {
          onClose();
          await logout();
        },
      },
    ]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} onShow={() => setDraftUrl(baseUrl)}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Text style={styles.title}>Settings</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Close settings" onPress={onClose} style={styles.close}>
          <Ionicons name="close" size={24} color={colors.text} />
        </Pressable>
      </View>
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.bg }}
        contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: insets.bottom + 24 }}
        keyboardShouldPersistTaps="handled"
      >
        <Card>
          <SectionTitle>Backend server</SectionTitle>
          <Field
            label="Base URL"
            value={draftUrl}
            onChangeText={setDraftUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="http://192.168.1.20:8080"
            hint="Local: your computer's Wi-Fi IP with HOST=0.0.0.0. Cloud: your https:// deployment URL."
          />
          <View style={styles.row}>
            <Button title="Test" variant="ghost" icon="pulse" onPress={testConnection} loading={testing} style={{ flex: 1 }} />
            <Button title="Save" icon="save-outline" onPress={save} style={{ flex: 1 }} />
          </View>
          <Pressable onPress={() => setDraftUrl(defaultBaseUrl())} style={{ marginTop: 10 }}>
            <Text style={styles.link}>Reset to default ({defaultBaseUrl()})</Text>
          </Pressable>
          {testMsg ? (
            <View style={{ marginTop: 10 }}>
              <Banner tone={testMsg.ok ? "green" : "red"} icon={testMsg.ok ? "checkmark-circle" : "alert-circle"} text={testMsg.text} />
            </View>
          ) : null}
        </Card>

        {session ? (
          <Card>
            <SectionTitle>Account</SectionTitle>
            <Muted>
              {session.role === "customer"
                ? `Signed in as ${session.customer.name} (${session.customer.phone})`
                : "Signed in as Provider"}
            </Muted>
            {session.role === "customer" && pushStatus ? (
              <Muted style={{ marginTop: 6 }}>Meal prompts: {pushStatus}</Muted>
            ) : null}
            <View style={[styles.row, { marginTop: 12, justifyContent: "space-between" }]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Demo Mode</Text>
                <Muted>Shows a quick role switcher in the header.</Muted>
              </View>
              <Switch
                value={demoMode}
                onValueChange={(v) => void setDemoMode(v)}
                trackColor={{ true: colors.primary, false: colors.border }}
                thumbColor="#fff"
              />
            </View>
            <Button title="Sign out" variant="danger" icon="log-out-outline" onPress={confirmLogout} style={{ marginTop: 14 }} />
          </Card>
        ) : null}

        {session?.role === "provider" ? (
          <Card>
            <SectionTitle>Change provider PIN</SectionTitle>
            <Field label="Current PIN" value={curPin} onChangeText={setCurPin} keyboardType="number-pad" secureTextEntry />
            <Field label="New PIN (4–8 digits)" value={newPin} onChangeText={setNewPin} keyboardType="number-pad" secureTextEntry />
            <Button title="Update PIN" variant="soft" icon="key-outline" onPress={changePin} loading={pinBusy} />
          </Card>
        ) : null}

        <Muted style={{ textAlign: "center" }}>DabbaTrack mobile v{Constants.expoConfig?.version ?? "1.0.0"}</Muted>
      </ScrollView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: { fontSize: 20, fontWeight: "800", color: colors.text },
  close: { width: 40, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: colors.graySoft },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  link: { color: colors.primaryDark, fontWeight: "600", fontSize: 13 },
  label: { fontSize: 15, fontWeight: "700", color: colors.text },
});
