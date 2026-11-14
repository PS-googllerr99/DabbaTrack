import { Ionicons } from "@expo/vector-icons";
import React, { useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import type { HistoryEntry } from "../../api/types";
import { PLAN_LABELS } from "../../api/types";
import { Card, Chip, Muted, Row, ScreenScroll, SectionTitle, StatusPill } from "../../components/ui";
import { formatDate, formatDateTime, formatMoney, titleCase } from "../../lib/format";
import { colors, STATUS_STYLE } from "../../theme";
import { useCustomerData } from "./CustomerApp";

type Filter = "all" | "delivered" | "paused" | "cancelled";

const ICONS: Record<string, React.ComponentProps<typeof Ionicons>["name"]> = {
  delivered: "qr-code",
  paused: "airplane",
  cancelled: "close-circle",
  confirmed: "checkmark-circle",
};

export function HistoryScreen() {
  const { summary, refreshing, refresh } = useCustomerData();
  const [filter, setFilter] = useState<Filter>("all");

  const entries = useMemo(
    () => summary.history.filter((h) => (filter === "all" ? true : h.status === filter)),
    [summary.history, filter],
  );

  const counts = useMemo(() => {
    const c = { delivered: 0, paused: 0, cancelled: 0 };
    for (const h of summary.history) if (h.status in c) c[h.status as keyof typeof c] += 1;
    return c;
  }, [summary.history]);

  return (
    <ScreenScroll refreshing={refreshing} onRefresh={refresh}>
      <Row style={{ flexWrap: "wrap" }}>
        <Chip label="All" active={filter === "all"} onPress={() => setFilter("all")} />
        <Chip label={`Delivered ${counts.delivered}`} active={filter === "delivered"} onPress={() => setFilter("delivered")} />
        <Chip label={`Paused ${counts.paused}`} active={filter === "paused"} onPress={() => setFilter("paused")} />
        <Chip label={`Cancelled ${counts.cancelled}`} active={filter === "cancelled"} onPress={() => setFilter("cancelled")} />
      </Row>

      <Card>
        {entries.length === 0 ? (
          <Muted>No entries yet.</Muted>
        ) : (
          entries.map((h, i) => <HistoryRow key={h.id} entry={h} first={i === 0} />)
        )}
      </Card>

      {summary.payments.length > 0 ? (
        <Card>
          <SectionTitle>Payments</SectionTitle>
          {summary.payments.map((p, i) => (
            <Row key={`${p.paid_at}-${i}`} style={[styles.row, i === 0 && { borderTopWidth: 0 }]}>
              <Ionicons name="wallet-outline" size={20} color={colors.primaryDark} />
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>
                  {formatMoney(p.amount)} · {p.diets_added} diets
                </Text>
                <Muted>
                  {formatDate(p.paid_at, true)} · {PLAN_LABELS[p.plan_type]} · {p.notes}
                </Muted>
              </View>
            </Row>
          ))}
        </Card>
      ) : null}
    </ScreenScroll>
  );
}

function HistoryRow({ entry, first }: { entry: HistoryEntry; first: boolean }) {
  const style = STATUS_STYLE[entry.status] ?? STATUS_STYLE.pending;
  const detail =
    entry.status === "delivered"
      ? `Scanned ${formatDateTime(entry.delivered_at)}${entry.marked_by_provider ? " · marked by provider" : ""}`
      : entry.responded_at
        ? `Updated ${formatDateTime(entry.responded_at)}`
        : "";
  return (
    <Row style={[styles.row, first && { borderTopWidth: 0 }]}>
      <View style={[styles.icon, { backgroundColor: style.bg }]}>
        <Ionicons name={ICONS[entry.status] ?? "ellipse"} size={18} color={style.fg} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>
          {formatDate(entry.meal_date, true)} · {titleCase(entry.meal_type)}
        </Text>
        {detail ? <Muted>{detail}</Muted> : null}
      </View>
      <StatusPill status={entry.status} />
    </Row>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.graySoft },
  rowTitle: { fontSize: 15, fontWeight: "700", color: colors.text },
  icon: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
});
