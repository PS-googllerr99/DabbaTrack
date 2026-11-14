import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Alert, Share, StyleSheet, Text, View } from "react-native";
import QRCode from "react-native-qrcode-svg";

import type { MealPromptResult, MealType } from "../../api/types";
import { Banner, Button, Card, Muted, Row, ScreenScroll, SectionTitle } from "../../components/ui";
import { formatDateTime, formatTime, titleCase } from "../../lib/format";
import { colors } from "../../theme";
import { useProviderData } from "./ProviderApp";

export function QrBroadcastScreen() {
  const { dash, api, reload, refreshing, refresh } = useProviderData();
  const [rotating, setRotating] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [results, setResults] = useState<Partial<Record<MealType, { res: MealPromptResult; preview: boolean }>>>({});

  const rotate = () =>
    Alert.alert(
      "Rotate QR token?",
      "Old printed or shared QR codes stop working immediately. Customers will need to scan the new one.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Rotate",
          style: "destructive",
          onPress: async () => {
            setRotating(true);
            try {
              await api.rotateQr();
              await reload();
            } catch (err) {
              Alert.alert("Rotate failed", err instanceof Error ? err.message : String(err));
            } finally {
              setRotating(false);
            }
          },
        },
      ],
    );

  const run = async (meal: MealType, preview: boolean) => {
    setSending(`${meal}-${preview}`);
    try {
      const res = await api.sendMealPrompt(meal, preview);
      setResults((r) => ({ ...r, [meal]: { res, preview } }));
      if (!preview) await reload();
    } catch (err) {
      Alert.alert("Prompt not sent", err instanceof Error ? err.message : String(err));
    } finally {
      setSending(null);
    }
  };

  const confirmSend = (meal: MealType) =>
    Alert.alert(
      `Send ${meal} pop-up?`,
      `Customers with ${meal} today get a push notification with the menu and Yes / Cancel buttons.`,
      [
        { text: "Not now", style: "cancel" },
        { text: "Send", onPress: () => void run(meal, false) },
      ],
    );

  const lastBroadcast = dash.popup_broadcast ? dash.popup_broadcast.split("|") : null;

  return (
    <ScreenScroll refreshing={refreshing} onRefresh={refresh}>
      <Card style={{ alignItems: "center", gap: 12 }}>
        <SectionTitle>Delivery QR code</SectionTitle>
        <View style={styles.qrWrap} accessibilityLabel={`QR code for ${dash.provider_qr_code}`}>
          <QRCode value={dash.provider_qr_code} size={220} color={colors.text} backgroundColor="#fff" quietZone={12} />
        </View>
        <Text style={styles.code} selectable>
          {dash.provider_qr_code}
        </Text>
        <Muted style={{ textAlign: "center" }}>
          Customers scan this on delivery to record the exact time and deduct one diet.
        </Muted>
        <Row style={{ alignSelf: "stretch" }}>
          <Button
            title="Share code"
            variant="ghost"
            icon="share-outline"
            onPress={() => Share.share({ message: `DabbaTrack delivery code: ${dash.provider_qr_code}` })}
            style={{ flex: 1 }}
          />
          <Button title="Rotate token" variant="soft" icon="refresh" onPress={rotate} loading={rotating} style={{ flex: 1 }} />
        </Row>
      </Card>

      <Card>
        <SectionTitle>Send meal confirmation pop-up</SectionTitle>
        <Muted style={{ marginBottom: 12 }}>
          Sends a push notification with today's menu to every customer due that meal. Tapping it opens the Yes /
          Cancel pop-up in their app.
        </Muted>
        {(["lunch", "dinner"] as MealType[]).map((meal) => {
          const queue = meal === "lunch" ? dash.lunch_queue : dash.dinner_queue;
          const menu = dash.menus[meal];
          const blocked = queue.is_locked ? queue.lock_reason : queue.is_holiday ? "Holiday today" : !menu ? "Publish the menu first" : null;
          const r = results[meal];
          return (
            <View key={meal} style={styles.mealBlock}>
              <Row style={{ justifyContent: "space-between" }}>
                <Row>
                  <Ionicons name={meal === "lunch" ? "sunny" : "moon"} size={20} color={colors.primary} />
                  <Text style={styles.mealTitle}>{titleCase(meal)}</Text>
                </Row>
                <Muted>Cutoff {formatTime(dash.cutoffs[meal])}</Muted>
              </Row>
              <Muted numberOfLines={2}>{menu ? `Menu: ${menu}` : "No menu published yet"}</Muted>
              {blocked ? <Banner tone="red" icon="lock-closed" text={blocked} /> : null}
              <Row>
                <Button
                  title="Preview"
                  variant="ghost"
                  small
                  icon="eye-outline"
                  onPress={() => run(meal, true)}
                  disabled={!!blocked || sending !== null}
                  loading={sending === `${meal}-true`}
                  style={{ flex: 1 }}
                />
                <Button
                  title={`Send ${titleCase(meal)}`}
                  small
                  icon="notifications"
                  onPress={() => confirmSend(meal)}
                  disabled={!!blocked || sending !== null}
                  loading={sending === `${meal}-false`}
                  style={{ flex: 1.4 }}
                />
              </Row>
              {r ? (
                <Banner
                  tone={r.preview ? "blue" : r.res.failed > 0 ? "red" : "green"}
                  icon={r.preview ? "people" : "paper-plane"}
                  text={
                    r.preview
                      ? `${r.res.recipients} customer(s) with push enabled would receive this.`
                      : `Sent to ${r.res.sent} of ${r.res.recipients} phone(s)` +
                        (r.res.failed ? ` · ${r.res.failed} failed` : "") +
                        (r.res.invalid_tokens.length ? ` · ${r.res.invalid_tokens.length} stale token(s) removed` : "") +
                        ". Open apps also show the pop-up."
                  }
                />
              ) : null}
            </View>
          );
        })}
        {lastBroadcast ? (
          <Muted style={{ marginTop: 6 }}>
            Last prompt: {titleCase(lastBroadcast[0])} · {formatDateTime(lastBroadcast[1])}
          </Muted>
        ) : null}
      </Card>
    </ScreenScroll>
  );
}

const styles = StyleSheet.create({
  qrWrap: { padding: 8, backgroundColor: "#fff", borderRadius: 16, borderWidth: 1, borderColor: colors.border },
  code: { fontSize: 18, fontWeight: "800", letterSpacing: 1, color: colors.text, fontVariant: ["tabular-nums"] },
  mealBlock: { gap: 8, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.graySoft },
  mealTitle: { fontSize: 16, fontWeight: "800", color: colors.text },
});
