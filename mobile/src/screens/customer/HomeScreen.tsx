import { Ionicons } from "@expo/vector-icons";
import { StyleSheet, Text, View } from "react-native";

import { PLAN_LABELS, PLAN_MEALS } from "../../api/types";
import { Banner, Button, Card, Muted, Pill, Row, ScreenScroll, SectionTitle, StatusPill } from "../../components/ui";
import { daysBetween, formatDate, formatDateTime, formatMoney, titleCase } from "../../lib/format";
import { colors } from "../../theme";
import { useCustomerData } from "./CustomerApp";

export function HomeScreen() {
  const { summary, refreshing, refresh, goTo } = useCustomerData();
  const { plan, customer, today_meals, upcoming_holidays } = summary;

  if (!plan) {
    return (
      <ScreenScroll refreshing={refreshing} onRefresh={refresh}>
        <Banner tone="primary" icon="information-circle" text="You don't have an active tiffin plan. Ask your provider to renew." />
      </ScreenScroll>
    );
  }

  const pct = plan.total_diets > 0 ? plan.diets_consumed / plan.total_diets : 0;
  const daysLeft = Math.max(0, daysBetween(summary.today, plan.estimated_end_date));
  const lowBalance = plan.diets_remaining <= 3;

  return (
    <ScreenScroll refreshing={refreshing} onRefresh={refresh}>
      <View style={styles.planCard}>
        <Row style={{ justifyContent: "space-between" }}>
          <Pill label={PLAN_LABELS[plan.plan_type]} fg="#fff" bg="rgba(255,255,255,0.22)" />
          <Text style={styles.planSmall}>Paid {formatDate(plan.payment_date)}</Text>
        </Row>
        <View style={styles.bigRow}>
          <Text style={styles.bigNumber}>{plan.diets_remaining}</Text>
          <Text style={styles.bigLabel}>diets{"\n"}remaining</Text>
        </View>
        <View style={styles.progressTrack} accessibilityLabel={`${plan.diets_consumed} of ${plan.total_diets} diets used`}>
          <View style={[styles.progressFill, { width: `${Math.min(100, pct * 100)}%` }]} />
        </View>
        <Text style={styles.planSmall}>
          {plan.diets_consumed} of {plan.total_diets} used · {formatMoney(plan.amount_paid)} paid
        </Text>
      </View>

      {lowBalance ? (
        <Banner tone="red" icon="warning" text={`Only ${plan.diets_remaining} diets left — contact your provider to renew.`} />
      ) : null}

      <View style={styles.statGrid}>
        <Card style={styles.stat}>
          <Ionicons name="calendar" size={20} color={colors.primary} />
          <Text style={styles.statValue}>{formatDate(plan.estimated_end_date, true)}</Text>
          <Muted>Estimated end · {daysLeft} day{daysLeft === 1 ? "" : "s"}</Muted>
        </Card>
        <Card style={styles.stat}>
          <Ionicons name="cube" size={20} color={colors.purple} />
          <Text style={styles.statValue}>{customer.boxes_with_customer}</Text>
          <Muted>Empty tiffin boxes with you</Muted>
        </Card>
      </View>
      <Muted style={{ marginTop: -6 }}>
        <Ionicons name="sparkles" size={12} color={colors.muted} /> End date auto-extends when you cancel a meal, pause for
        vacation, or the kitchen is on holiday.
      </Muted>

      <Card>
        <SectionTitle right={<Button title="Open menu" small variant="soft" onPress={() => goTo("menu")} />}>Today</SectionTitle>
        {PLAN_MEALS[plan.plan_type].map((meal) => {
          const m = today_meals[meal];
          return (
            <Row key={meal} style={styles.mealRow}>
              <Ionicons name={meal === "lunch" ? "sunny-outline" : "moon-outline"} size={20} color={colors.primaryDark} />
              <View style={{ flex: 1 }}>
                <Text style={styles.mealName}>{titleCase(meal)}</Text>
                <Muted>
                  {m?.delivered_at
                    ? `Delivered ${formatDateTime(m.delivered_at)}`
                    : m?.is_locked
                      ? "Locked (cutoff passed)"
                      : `Respond by ${summary.cutoffs[meal]}`}
                </Muted>
              </View>
              <StatusPill status={m?.status ?? "pending"} />
            </Row>
          );
        })}
      </Card>

      <Card>
        <SectionTitle>Plan details</SectionTitle>
        <Detail label="Start date" value={formatDate(plan.start_date, true)} />
        <Detail label="Payment date" value={formatDate(plan.payment_date, true)} />
        <Detail label="Delivery area" value={customer.route_area} />
        <Detail label="Address" value={customer.address} />
      </Card>

      {upcoming_holidays.length > 0 ? (
        <Card warm>
          <SectionTitle>Kitchen holidays</SectionTitle>
          {upcoming_holidays.slice(0, 5).map((h) => (
            <Detail
              key={`${h.holiday_date}-${h.meal_scope}`}
              label={formatDate(h.holiday_date, true)}
              value={`${h.meal_scope === "full_day" ? "Full day" : titleCase(h.meal_scope)}${h.reason ? ` · ${h.reason}` : ""}`}
            />
          ))}
        </Card>
      ) : null}
    </ScreenScroll>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detail}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  planCard: { backgroundColor: colors.primary, borderRadius: 20, padding: 18, gap: 10 },
  planSmall: { color: "#FFF7ED", fontSize: 13, fontWeight: "600" },
  bigRow: { flexDirection: "row", alignItems: "flex-end", gap: 10 },
  bigNumber: { fontSize: 56, fontWeight: "900", color: "#fff", lineHeight: 60 },
  bigLabel: { color: "#FFF7ED", fontSize: 15, fontWeight: "700", marginBottom: 8 },
  progressTrack: { height: 8, borderRadius: 4, backgroundColor: "rgba(255,255,255,0.3)", overflow: "hidden" },
  progressFill: { height: 8, borderRadius: 4, backgroundColor: "#fff" },
  statGrid: { flexDirection: "row", gap: 12 },
  stat: { flex: 1, gap: 4 },
  statValue: { fontSize: 18, fontWeight: "800", color: colors.text },
  mealRow: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.graySoft },
  mealName: { fontSize: 15, fontWeight: "700", color: colors.text },
  detail: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6, gap: 12 },
  detailLabel: { color: colors.muted, fontSize: 14 },
  detailValue: { color: colors.text, fontSize: 14, fontWeight: "600", flexShrink: 1, textAlign: "right" },
});
