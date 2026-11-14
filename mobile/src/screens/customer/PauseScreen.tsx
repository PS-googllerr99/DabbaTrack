import { useMemo, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";

import type { PauseScope } from "../../api/types";
import { Banner, Button, Card, DateStepper, Muted, Row, ScreenScroll, Segmented, SectionTitle } from "../../components/ui";
import { addDays, daysBetween, formatDate, titleCase } from "../../lib/format";
import { colors } from "../../theme";
import { useCustomerData } from "./CustomerApp";

interface PausedRange {
  start: string;
  end: string;
  meals: string[];
}

/** Collapse paused meal logs into contiguous date ranges for display. */
function groupPaused(entries: { meal_date: string; meal_type: string }[], fromDate: string): PausedRange[] {
  const byDate = new Map<string, Set<string>>();
  for (const e of entries) {
    if (e.meal_date < fromDate) continue;
    if (!byDate.has(e.meal_date)) byDate.set(e.meal_date, new Set());
    byDate.get(e.meal_date)!.add(e.meal_type);
  }
  const dates = [...byDate.keys()].sort();
  const ranges: PausedRange[] = [];
  for (const d of dates) {
    const last = ranges[ranges.length - 1];
    const meals = [...byDate.get(d)!].sort();
    if (last && addDays(last.end, 1) === d) {
      last.end = d;
      for (const m of meals) if (!last.meals.includes(m)) last.meals.push(m);
    } else {
      ranges.push({ start: d, end: d, meals });
    }
  }
  return ranges;
}

export function PauseScreen() {
  const { summary, api, customerId, reload, refreshing, refresh } = useCustomerData();
  const today = summary.today;
  const [start, setStart] = useState(addDays(today, 1));
  const [end, setEnd] = useState(addDays(today, 3));
  const [scope, setScope] = useState<PauseScope>("all");
  const [busy, setBusy] = useState<"pause" | "resume" | null>(null);
  const [message, setMessage] = useState<{ tone: "green" | "red"; text: string } | null>(null);

  const planType = summary.plan?.plan_type;
  const scopeOptions = useMemo(() => {
    const opts: { value: PauseScope; label: string }[] = [{ value: "all", label: "All meals" }];
    if (planType === "both") {
      opts.push({ value: "lunch", label: "Lunch" }, { value: "dinner", label: "Dinner" });
    }
    return opts;
  }, [planType]);

  const paused = useMemo(
    () => groupPaused(summary.history.filter((h) => h.status === "paused"), today),
    [summary.history, today],
  );

  if (!summary.plan) {
    return (
      <ScreenScroll>
        <Banner icon="information-circle" text="No active plan to pause." />
      </ScreenScroll>
    );
  }

  const days = daysBetween(start, end) + 1;
  const invalid = end < start ? "End date must be on or after start date" : days > 91 ? "Pause can be at most 90 days" : null;

  const setStartSafe = (d: string) => {
    setStart(d);
    if (end < d) setEnd(d);
  };

  const doPause = async () => {
    setBusy("pause");
    setMessage(null);
    try {
      const res = await api.pause(customerId, start, end, scope);
      await reload();
      const skipped = res.skipped_locked ? ` (${res.skipped_locked} already past cutoff, not paused)` : "";
      setMessage({
        tone: "green",
        text: `Paused ${res.paused_meals} meal(s)${skipped}. Plan now ends ${formatDate(res.estimated_end_date, true)}.`,
      });
    } catch (err) {
      setMessage({ tone: "red", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const doResume = async (rStart: string, rEnd: string) => {
    setBusy("resume");
    setMessage(null);
    try {
      const res = await api.resume(customerId, rStart, rEnd);
      await reload();
      setMessage({
        tone: "green",
        text: `Resumed ${res.resumed_meals} meal(s). Plan now ends ${formatDate(res.estimated_end_date, true)}.`,
      });
    } catch (err) {
      setMessage({ tone: "red", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const confirmResume = (r: PausedRange) =>
    Alert.alert("Resume deliveries?", `${formatDate(r.start)} – ${formatDate(r.end)} will go back to normal delivery.`, [
      { text: "Keep paused", style: "cancel" },
      { text: "Resume", onPress: () => void doResume(r.start, r.end) },
    ]);

  return (
    <ScreenScroll refreshing={refreshing} onRefresh={refresh}>
      <Card>
        <SectionTitle>Vacation pause</SectionTitle>
        <Muted style={{ marginBottom: 12 }}>
          Going away? Pause tiffins for a date range — no diets are used and your plan end date extends automatically.
        </Muted>
        <DateStepper label="From" value={start} onChange={setStartSafe} min={today} />
        <DateStepper label="To (inclusive)" value={end} onChange={setEnd} min={start} />
        {scopeOptions.length > 1 ? (
          <View style={{ marginBottom: 12 }}>
            <Text style={styles.label}>Meals to pause</Text>
            <Segmented<PauseScope> value={scope} onChange={setScope} options={scopeOptions} />
          </View>
        ) : null}
        <Text style={styles.summary}>
          {days > 0 ? `${days} day${days === 1 ? "" : "s"} · ${scope === "all" ? "all meals" : `${scope} only`}` : ""}
        </Text>
        {invalid ? <Banner tone="red" icon="alert-circle" text={invalid} /> : null}
        <Row style={{ marginTop: 10 }}>
          <Button
            title="Resume range"
            variant="ghost"
            icon="play-circle-outline"
            onPress={() => doResume(start, end)}
            disabled={!!invalid || busy !== null}
            loading={busy === "resume"}
            style={{ flex: 1 }}
          />
          <Button
            title="Pause"
            icon="pause-circle"
            onPress={doPause}
            disabled={!!invalid || busy !== null}
            loading={busy === "pause"}
            style={{ flex: 1 }}
          />
        </Row>
      </Card>

      {message ? <Banner tone={message.tone} icon={message.tone === "green" ? "checkmark-circle" : "alert-circle"} text={message.text} /> : null}

      <Card>
        <SectionTitle>Upcoming pauses</SectionTitle>
        {paused.length === 0 ? (
          <Muted>No upcoming pauses.</Muted>
        ) : (
          paused.map((r) => (
            <Row key={r.start} style={styles.rangeRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rangeTitle}>
                  {formatDate(r.start, true)}
                  {r.end !== r.start ? ` → ${formatDate(r.end, true)}` : ""}
                </Text>
                <Muted>{r.meals.map(titleCase).join(" + ")}</Muted>
              </View>
              <Button title="Resume" small variant="soft" onPress={() => confirmResume(r)} disabled={busy !== null} />
            </Row>
          ))
        )}
      </Card>
    </ScreenScroll>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 13, fontWeight: "600", color: colors.gray, marginBottom: 6 },
  summary: { fontSize: 14, fontWeight: "700", color: colors.primaryDark, marginBottom: 6 },
  rangeRow: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.graySoft },
  rangeTitle: { fontSize: 15, fontWeight: "700", color: colors.text },
});
