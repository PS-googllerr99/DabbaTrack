import { Ionicons } from "@expo/vector-icons";
import React, { useMemo, useState } from "react";
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import type { MealType, QueueItem } from "../../api/types";
import { PLAN_LABELS } from "../../api/types";
import { Banner, Button, Card, Chip, Kpi, Muted, Row, ScreenScroll, Segmented, StatusPill } from "../../components/ui";
import { formatDate, formatDateTime } from "../../lib/format";
import { colors } from "../../theme";
import { useProviderData } from "./ProviderApp";

type StatusFilter = "todo" | "all";

export function QueueScreen() {
  const { dash, api, reload, refreshing, refresh } = useProviderData();
  const [meal, setMeal] = useState<MealType>(() => (dash.current_time < "15:30" ? "lunch" : "dinner"));
  const [route, setRoute] = useState<string>("ALL");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("todo");
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const queue = meal === "lunch" ? dash.lunch_queue : dash.dinner_queue;
  const routeNames = useMemo(() => queue.routes.map((r) => r.route_area), [queue.routes]);
  const activeRoute = route !== "ALL" && !routeNames.includes(route) ? "ALL" : route;

  const groups = useMemo(
    () =>
      queue.routes
        .filter((r) => activeRoute === "ALL" || r.route_area === activeRoute)
        .map((r) => ({
          ...r,
          visible: r.items.filter((i) => statusFilter === "all" || i.status === "pending" || i.status === "confirmed"),
        })),
    [queue.routes, activeRoute, statusFilter],
  );

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusyKey(key);
    try {
      await fn();
      await reload();
    } catch (err) {
      Alert.alert("Action failed", err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const deliver = (item: QueueItem, boxReturned: boolean) =>
    act(`${item.customer_id}-deliver-${boxReturned}`, () => api.manualDeliver(item.customer_id, meal, boxReturned));

  const boxBack = (item: QueueItem) => act(`${item.customer_id}-box`, () => api.adjustBoxes(item.customer_id, -1));

  return (
    <ScreenScroll refreshing={refreshing} onRefresh={refresh}>
      <View style={styles.kpis}>
        <Kpi label="Lunch left to deliver" value={dash.lunch_queue.counts.left_to_deliver} tone="primary" />
        <Kpi label="Dinner left to deliver" value={dash.dinner_queue.counts.left_to_deliver} tone="blue" />
        <Kpi label="Empty boxes out" value={dash.total_boxes_out} tone="purple" />
        <Kpi label="Expiring soon (≤ 3 diets)" value={dash.expiring_soon.length} tone="red" />
      </View>

      <Segmented<MealType>
        value={meal}
        onChange={setMeal}
        options={[
          { value: "lunch", label: `Lunch (${dash.lunch_queue.counts.left_to_deliver})` },
          { value: "dinner", label: `Dinner (${dash.dinner_queue.counts.left_to_deliver})` },
        ]}
      />

      {queue.is_holiday ? (
        <Banner icon="sunny" text={`Holiday — no ${meal} deliveries today${queue.holiday_reason ? ` (${queue.holiday_reason})` : ""}.`} />
      ) : null}

      <Row style={{ justifyContent: "space-between" }}>
        <Muted>
          {queue.counts.delivered} delivered · {queue.counts.cancelled} cancelled · {queue.counts.paused} paused
        </Muted>
        <Pressable onPress={() => setStatusFilter(statusFilter === "todo" ? "all" : "todo")}>
          <Text style={styles.link}>{statusFilter === "todo" ? "Show all" : "Only to-do"}</Text>
        </Pressable>
      </Row>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        <Chip label={`All routes`} active={activeRoute === "ALL"} onPress={() => setRoute("ALL")} />
        {queue.routes.map((r) => (
          <Chip
            key={r.route_area}
            label={`${r.route_area} · ${r.left_to_deliver}`}
            active={activeRoute === r.route_area}
            onPress={() => setRoute(r.route_area)}
          />
        ))}
      </ScrollView>

      {groups.every((g) => g.visible.length === 0) ? (
        <Card>
          <Row>
            <Ionicons name="checkmark-done-circle" size={28} color={colors.green} />
            <Muted style={{ flex: 1 }}>
              {queue.items.length === 0 ? `No ${meal} customers today.` : `All ${meal} deliveries done for this route.`}
            </Muted>
          </Row>
        </Card>
      ) : null}

      {groups
        .filter((g) => g.visible.length > 0)
        .map((g) => (
          <View key={g.route_area} style={{ gap: 10 }}>
            <Row style={{ justifyContent: "space-between" }}>
              <Row>
                <Ionicons name="location" size={16} color={colors.primaryDark} />
                <Text style={styles.routeTitle}>{g.route_area}</Text>
              </Row>
              <Muted>
                {g.left_to_deliver} left / {g.total}
              </Muted>
            </Row>
            {g.visible.map((item) => (
              <DeliveryCard
                key={item.customer_id}
                item={item}
                busyKey={busyKey}
                onDeliver={(b) => deliver(item, b)}
                onBoxBack={() => boxBack(item)}
              />
            ))}
          </View>
        ))}
    </ScreenScroll>
  );
}

function DeliveryCard({
  item,
  busyKey,
  onDeliver,
  onBoxBack,
}: {
  item: QueueItem;
  busyKey: string | null;
  onDeliver: (boxReturned: boolean) => void;
  onBoxBack: () => void;
}) {
  const todo = item.status === "pending" || item.status === "confirmed";
  const k = (s: string) => `${item.customer_id}-${s}`;
  const busy = busyKey !== null;
  return (
    <Card style={{ gap: 10 }}>
      <Row style={{ alignItems: "flex-start" }}>
        <View style={{ flex: 1 }}>
          <Text style={styles.name}>{item.name}</Text>
          <Muted>{item.address}</Muted>
        </View>
        <StatusPill status={item.status} />
      </Row>
      <Row style={{ flexWrap: "wrap", gap: 12 }}>
        <Meta icon="restaurant-outline" text={PLAN_LABELS[item.plan_type]} />
        <Meta
          icon="pie-chart-outline"
          text={`${item.diets_remaining} diets left`}
          color={item.diets_remaining <= 3 ? colors.red : undefined}
        />
        <Meta icon="cube-outline" text={`${item.boxes_with_customer} box${item.boxes_with_customer === 1 ? "" : "es"} out`} />
        <Meta icon="calendar-outline" text={`Ends ${formatDate(item.estimated_end_date)}`} />
      </Row>
      {item.delivered_at ? <Muted>Delivered {formatDateTime(item.delivered_at)}</Muted> : null}
      {todo ? (
        <View style={{ gap: 8 }}>
          <Button
            title="Deliver + Box Returned"
            icon="swap-horizontal"
            variant="success"
            onPress={() => onDeliver(true)}
            loading={busyKey === k("deliver-true")}
            disabled={busy}
          />
          <Row>
            <Button
              title="Deliver Only"
              icon="checkmark"
              variant="soft"
              small
              onPress={() => onDeliver(false)}
              loading={busyKey === k("deliver-false")}
              disabled={busy}
              style={{ flex: 1 }}
            />
            <Button
              title="Box Returned (-1)"
              icon="cube"
              variant="ghost"
              small
              onPress={onBoxBack}
              loading={busyKey === k("box")}
              disabled={busy || item.boxes_with_customer <= 0}
              style={{ flex: 1 }}
            />
          </Row>
        </View>
      ) : (
        <Row>
          {item.boxes_with_customer > 0 ? (
            <Button
              title="Box Returned (-1)"
              icon="cube"
              variant="ghost"
              small
              onPress={onBoxBack}
              loading={busyKey === k("box")}
              disabled={busy}
              style={{ flex: 1 }}
            />
          ) : null}
        </Row>
      )}
      <Pressable onPress={() => Linking.openURL(`tel:${item.phone}`)} style={styles.callRow} accessibilityRole="link">
        <Ionicons name="call-outline" size={15} color={colors.primaryDark} />
        <Text style={styles.link}>Call {item.name.split(" ")[0]} · {item.phone}</Text>
      </Pressable>
    </Card>
  );
}

function Meta({ icon, text, color }: { icon: React.ComponentProps<typeof Ionicons>["name"]; text: string; color?: string }) {
  return (
    <Row style={{ gap: 4 }}>
      <Ionicons name={icon} size={14} color={color ?? colors.muted} />
      <Text style={[styles.meta, color ? { color, fontWeight: "700" } : null]}>{text}</Text>
    </Row>
  );
}

const styles = StyleSheet.create({
  kpis: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  routeTitle: { fontSize: 16, fontWeight: "800", color: colors.text },
  name: { fontSize: 16, fontWeight: "800", color: colors.text },
  meta: { fontSize: 12, color: colors.gray },
  link: { color: colors.primaryDark, fontWeight: "600", fontSize: 13 },
  callRow: { flexDirection: "row", alignItems: "center", gap: 6 },
});
