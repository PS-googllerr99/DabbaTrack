import { Ionicons } from "@expo/vector-icons";
import { type BarcodeScanningResult, CameraView, useCameraPermissions } from "expo-camera";
import { useRef, useState } from "react";
import { StyleSheet, Switch, Text, View } from "react-native";

import type { MealType, ScanResult } from "../../api/types";
import { PLAN_MEALS } from "../../api/types";
import { Banner, Button, Card, Field, Muted, Row, ScreenScroll, Segmented } from "../../components/ui";
import { formatDate, formatDateTime, titleCase } from "../../lib/format";
import { colors } from "../../theme";
import { useCustomerData } from "./CustomerApp";

function defaultMeal(meals: MealType[], nowHHMM: string): MealType {
  if (meals.length === 1) return meals[0];
  return nowHHMM < "15:30" ? "lunch" : "dinner";
}

export function ScanScreen() {
  const { summary, api, customerId, reload } = useCustomerData();
  const meals = summary.plan ? PLAN_MEALS[summary.plan.plan_type] : [];
  const [permission, requestPermission] = useCameraPermissions();
  const [meal, setMeal] = useState<MealType>(() => defaultMeal(meals.length ? meals : ["lunch"], summary.current_time));
  const [boxReturned, setBoxReturned] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ meal: MealType; data: ScanResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState("");
  const lockRef = useRef(false);

  if (!summary.plan) {
    return (
      <ScreenScroll>
        <Banner icon="information-circle" text="No active plan — nothing to scan." />
      </ScreenScroll>
    );
  }

  const todayMeal = summary.today_meals[meal];
  const alreadyDelivered = todayMeal?.status === "delivered";

  const submit = async (token: string) => {
    if (lockRef.current) return;
    lockRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const data = await api.scanQr(customerId, meal, token.trim(), boxReturned);
      setResult({ meal, data });
      setCameraOn(false);
      setManualCode("");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCameraOn(false);
    } finally {
      setBusy(false);
      // Small delay so the camera doesn't immediately re-fire on the same code.
      setTimeout(() => {
        lockRef.current = false;
      }, 800);
    }
  };

  const onScanned = (res: BarcodeScanningResult) => {
    if (!res.data || lockRef.current) return;
    void submit(res.data);
  };

  const startCamera = async () => {
    setError(null);
    setResult(null);
    if (!permission?.granted) {
      const next = await requestPermission();
      if (!next.granted) {
        setError("Camera permission is needed to scan the provider's QR. You can enter the code manually below.");
        return;
      }
    }
    setCameraOn(true);
  };

  return (
    <ScreenScroll>
      {result ? (
        <Card style={styles.success}>
          <Row>
            <Ionicons name="checkmark-circle" size={34} color={colors.green} />
            <View style={{ flex: 1 }}>
              <Text style={styles.successTitle}>{titleCase(result.meal)} delivered</Text>
              <Muted>{formatDateTime(result.data.delivered_at)}</Muted>
            </View>
          </Row>
          <View style={styles.resultGrid}>
            <ResultStat label="Diets left" value={String(result.data.diets_remaining)} />
            <ResultStat label="Boxes with you" value={String(result.data.boxes_with_customer)} />
            <ResultStat label="Plan ends" value={formatDate(result.data.estimated_end_date)} />
          </View>
          <Button title="Done" variant="ghost" onPress={() => setResult(null)} />
        </Card>
      ) : null}

      <Card>
        <Text style={styles.title}>Confirm delivery</Text>
        <Muted style={{ marginBottom: 12 }}>
          Scan the QR on your delivery person's phone or the sticker on the tiffin bag to record the exact delivery time.
        </Muted>

        {meals.length > 1 ? (
          <Segmented<MealType>
            value={meal}
            onChange={setMeal}
            options={meals.map((m) => ({ value: m, label: titleCase(m) }))}
          />
        ) : (
          <Muted>Meal: {titleCase(meal)}</Muted>
        )}

        <Row style={styles.switchRow}>
          <Ionicons name="cube-outline" size={22} color={colors.purple} />
          <View style={{ flex: 1 }}>
            <Text style={styles.switchLabel}>Returning empty tiffin box</Text>
            <Muted>You have {summary.customer.boxes_with_customer} empty box(es) at home</Muted>
          </View>
          <Switch
            value={boxReturned}
            onValueChange={setBoxReturned}
            trackColor={{ true: colors.purple, false: colors.border }}
            thumbColor="#fff"
            accessibilityLabel="Returning empty tiffin box"
          />
        </Row>

        {alreadyDelivered ? (
          <Banner tone="green" icon="checkmark-done" text={`Today's ${meal} was already scanned at ${formatDateTime(todayMeal?.delivered_at)}`} />
        ) : null}
      </Card>

      {cameraOn ? (
        <View style={styles.cameraWrap}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={busy ? undefined : onScanned}
          />
          <View style={styles.frame} pointerEvents="none" />
          <View style={styles.cameraFooter}>
            <Text style={styles.cameraHint}>{busy ? "Recording delivery…" : "Point at the provider's QR code"}</Text>
            <Button title="Close camera" small variant="ghost" onPress={() => setCameraOn(false)} />
          </View>
        </View>
      ) : (
        <Button title={`Scan QR for ${titleCase(meal)}`} icon="scan" onPress={startCamera} disabled={busy} />
      )}

      {error ? <Banner tone="red" icon="alert-circle" text={error} /> : null}

      <Card>
        <Text style={styles.switchLabel}>Camera not working?</Text>
        <Field
          label="Enter the code printed under the QR"
          value={manualCode}
          onChangeText={setManualCode}
          autoCapitalize="characters"
          autoCorrect={false}
          placeholder="Code printed under the QR"
        />
        <Button
          title="Submit code"
          variant="soft"
          icon="keypad-outline"
          onPress={() => submit(manualCode)}
          disabled={!manualCode.trim()}
          loading={busy && !cameraOn}
        />
      </Card>
    </ScreenScroll>
  );
}

function ResultStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.resultStat}>
      <Text style={styles.resultValue}>{value}</Text>
      <Muted>{label}</Muted>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 18, fontWeight: "800", color: colors.text, marginBottom: 4 },
  switchRow: { marginTop: 14, marginBottom: 6 },
  switchLabel: { fontSize: 15, fontWeight: "700", color: colors.text, marginBottom: 2 },
  cameraWrap: { height: 360, borderRadius: 20, overflow: "hidden", backgroundColor: "#000" },
  frame: {
    position: "absolute",
    top: 60,
    left: "18%",
    right: "18%",
    aspectRatio: 1,
    borderWidth: 3,
    borderColor: colors.primary,
    borderRadius: 18,
  },
  cameraFooter: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    padding: 12,
    backgroundColor: "rgba(0,0,0,0.55)",
    gap: 8,
    alignItems: "center",
  },
  cameraHint: { color: "#fff", fontWeight: "600" },
  success: { backgroundColor: colors.greenSoft, borderColor: colors.green, gap: 12 },
  successTitle: { fontSize: 18, fontWeight: "800", color: colors.text },
  resultGrid: { flexDirection: "row", gap: 8 },
  resultStat: { flex: 1, backgroundColor: colors.surface, borderRadius: 12, padding: 10, alignItems: "center" },
  resultValue: { fontSize: 18, fontWeight: "800", color: colors.text },
});
