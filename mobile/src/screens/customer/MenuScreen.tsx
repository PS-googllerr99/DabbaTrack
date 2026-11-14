import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";

import type { MealType } from "../../api/types";
import { PLAN_MEALS } from "../../api/types";
import { Banner, Button, Card, Muted, Row, ScreenScroll, StatusPill } from "../../components/ui";
import { formatDate, formatDateTime, formatTime, titleCase } from "../../lib/format";
import { colors } from "../../theme";
import { useCustomerData } from "./CustomerApp";

export function MenuScreen() {
  const { summary, api, customerId, reload, refreshing, refresh } = useCustomerData();
  const [busy, setBusy] = useState<string | null>(null);
  const planMeals = summary.plan ? PLAN_MEALS[summary.plan.plan_type] : [];

  const respond = async (meal: MealType, wants: boolean) => {
    setBusy(`${meal}-${wants}`);
    try {
      const res = await api.respondToMeal(customerId, meal, wants, summary.today);
      await reload();
      if (!wants) {
        Alert.alert(`${titleCase(meal)} cancelled`, `No diet used. Plan now ends around ${formatDate(res.estimated_end_date, true)}.`);
      }
    } catch (err) {
      Alert.alert("Could not update", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScreenScroll refreshing={refreshing} onRefresh={refresh}>
      <Muted>
        {formatDate(summary.today, true)} · now {formatTime(summary.current_time)}
      </Muted>
      {(["lunch", "dinner"] as MealType[]).map((meal) => {
        const inPlan = planMeals.includes(meal);
        const m = summary.today_meals[meal];
        const menu = summary.menus[meal];
        const cutoff = summary.cutoffs[meal];
        const done = m?.status === "delivered" || m?.is_holiday;
        const canAct = inPlan && !!m && !m.is_locked && !done;
        return (
          <Card key={meal} style={!inPlan && { opacity: 0.55 }}>
            <Row style={{ justifyContent: "space-between", marginBottom: 10 }}>
              <Row>
                <View style={styles.mealIcon}>
                  <Ionicons name={meal === "lunch" ? "sunny" : "moon"} size={20} color={colors.primary} />
                </View>
                <View>
                  <Text style={styles.mealTitle}>{titleCase(meal)}</Text>
                  <Muted>Cutoff {formatTime(cutoff)}</Muted>
                </View>
              </Row>
              {inPlan ? <StatusPill status={m?.status ?? "pending"} /> : <Muted>Not in plan</Muted>}
            </Row>

            <View style={styles.menuBox}>
              <Text style={styles.menuText}>{menu || "Menu not published yet — check back soon."}</Text>
            </View>

            {inPlan && m ? (
              <View style={{ marginTop: 12, gap: 10 }}>
                {m.is_holiday ? <Banner icon="sunny" text="Kitchen holiday — no delivery, no diet used." /> : null}
                {m.status === "delivered" && m.delivered_at ? (
                  <Banner tone="green" icon="checkmark-done" text={`Delivered at ${formatDateTime(m.delivered_at)}`} />
                ) : null}
                {m.is_locked && !done ? (
                  <Banner tone="red" icon="lock-closed" text={m.lock_reason || "Cutoff has passed"} />
                ) : null}
                {canAct ? (
                  <Row>
                    <Button
                      title={m.status === "cancelled" ? "Cancelled" : "Cancel"}
                      variant="danger"
                      icon="close-circle"
                      onPress={() => respond(meal, false)}
                      disabled={m.status === "cancelled" || busy !== null}
                      loading={busy === `${meal}-false`}
                      style={{ flex: 1 }}
                    />
                    <Button
                      title={m.status === "confirmed" ? "Confirmed" : "Yes, send"}
                      variant="success"
                      icon="checkmark-circle"
                      onPress={() => respond(meal, true)}
                      disabled={m.status === "confirmed" || busy !== null}
                      loading={busy === `${meal}-true`}
                      style={{ flex: 1 }}
                    />
                  </Row>
                ) : null}
                {canAct && m.status === "paused" ? (
                  <Muted>This meal is paused for vacation. Tap "Yes, send" to get it anyway.</Muted>
                ) : null}
              </View>
            ) : null}
          </Card>
        );
      })}
      <Muted style={{ textAlign: "center" }}>
        Not responding counts as "Yes" — your tiffin is sent unless you cancel before the cutoff.
      </Muted>
    </ScreenScroll>
  );
}

const styles = StyleSheet.create({
  mealIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: colors.primarySoft,
    alignItems: "center",
    justifyContent: "center",
  },
  mealTitle: { fontSize: 18, fontWeight: "800", color: colors.text },
  menuBox: { backgroundColor: colors.surfaceWarm, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: colors.primarySoft },
  menuText: { fontSize: 15, lineHeight: 22, color: colors.text },
});
