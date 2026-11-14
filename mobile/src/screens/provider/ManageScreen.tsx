import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";

import type { HolidayScope, MealType } from "../../api/types";
import { Banner, Button, Card, DateStepper, Field, Muted, Row, ScreenScroll, Segmented, SectionTitle } from "../../components/ui";
import { addDays, formatDate, TIME_RE, titleCase } from "../../lib/format";
import { colors } from "../../theme";
import { useProviderData } from "./ProviderApp";

export function ManageScreen() {
  const { refreshing, refresh } = useProviderData();
  return (
    <ScreenScroll refreshing={refreshing} onRefresh={refresh}>
      <MenusCard />
      <CutoffsCard />
      <HolidaysCard />
    </ScreenScroll>
  );
}

function MenusCard() {
  const { dash, api, reload } = useProviderData();
  const [menus, setMenus] = useState(dash.menus);
  const [busy, setBusy] = useState<MealType | null>(null);

  // Pick up server changes (e.g. another device) unless the field is being edited differently.
  useEffect(() => setMenus(dash.menus), [dash.menus.lunch, dash.menus.dinner]); // eslint-disable-line react-hooks/exhaustive-deps

  const publish = async (meal: MealType) => {
    if (!menus[meal].trim()) return Alert.alert("Menu is empty", `Describe today's ${meal} first.`);
    setBusy(meal);
    try {
      await api.publishMenu(meal, menus[meal], dash.today);
      await reload();
      Alert.alert("Menu published", `Customers now see today's ${meal} menu.`);
    } catch (err) {
      Alert.alert("Publish failed", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <SectionTitle>Today's menu · {formatDate(dash.today, true)}</SectionTitle>
      {(["lunch", "dinner"] as MealType[]).map((meal) => {
        const changed = menus[meal].trim() !== dash.menus[meal];
        return (
          <View key={meal} style={{ marginBottom: 8 }}>
            <Field
              label={`${titleCase(meal)}${dash.menus[meal] ? (changed ? " · unsaved changes" : " · published") : " · not published"}`}
              value={menus[meal]}
              onChangeText={(t) => setMenus((m) => ({ ...m, [meal]: t }))}
              multiline
              maxLength={500}
              placeholder={meal === "lunch" ? "Dal Tadka, Jeera Rice, 4 Roti, Sabzi" : "Paneer Masala, 4 Phulka, Rice, Raita"}
            />
            <Button
              title={`Publish ${titleCase(meal)}`}
              small
              variant={changed ? "primary" : "soft"}
              icon="megaphone-outline"
              onPress={() => publish(meal)}
              loading={busy === meal}
              disabled={busy !== null}
            />
          </View>
        );
      })}
    </Card>
  );
}

function CutoffsCard() {
  const { dash, api, reload } = useProviderData();
  const [lunch, setLunch] = useState(dash.cutoffs.lunch);
  const [dinner, setDinner] = useState(dash.cutoffs.dinner);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!TIME_RE.test(lunch) || !TIME_RE.test(dinner)) {
      return Alert.alert("Invalid time", "Use 24-hour HH:MM, e.g. 10:00 and 17:30.");
    }
    setBusy(true);
    try {
      await api.setCutoffs(lunch, dinner);
      await reload();
      Alert.alert("Cutoffs saved", `Lunch locks at ${lunch}, dinner at ${dinner}.`);
    } catch (err) {
      Alert.alert("Save failed", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const fmt = (t: string) => {
    const digits = t.replace(/\D/g, "").slice(0, 4);
    return digits.length > 2 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits;
  };

  return (
    <Card>
      <SectionTitle>Response cutoffs</SectionTitle>
      <Muted style={{ marginBottom: 10 }}>After the cutoff customers can't confirm, cancel or pause that meal.</Muted>
      <Row>
        <View style={{ flex: 1 }}>
          <Field label="Lunch (HH:MM)" value={lunch} onChangeText={(t) => setLunch(fmt(t))} keyboardType="number-pad" maxLength={5} />
        </View>
        <View style={{ flex: 1 }}>
          <Field label="Dinner (HH:MM)" value={dinner} onChangeText={(t) => setDinner(fmt(t))} keyboardType="number-pad" maxLength={5} />
        </View>
      </Row>
      <Button title="Save cutoffs" small icon="time-outline" onPress={save} loading={busy} />
    </Card>
  );
}

const SCOPES: { value: HolidayScope; label: string }[] = [
  { value: "full_day", label: "Full day" },
  { value: "lunch", label: "Lunch" },
  { value: "dinner", label: "Dinner" },
];

function HolidaysCard() {
  const { dash, api, reload } = useProviderData();
  const [date, setDate] = useState(addDays(dash.today, 1));
  const [scope, setScope] = useState<HolidayScope>("full_day");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const upcoming = dash.holidays.filter((h) => h.holiday_date >= dash.today).sort((a, b) => a.holiday_date.localeCompare(b.holiday_date));
  const past = dash.holidays.filter((h) => h.holiday_date < dash.today).slice(0, 5);

  const add = async () => {
    setBusy(true);
    try {
      await api.addHoliday(date, scope, reason.trim());
      setReason("");
      await reload();
    } catch (err) {
      Alert.alert("Could not add holiday", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = (id: number, label: string) =>
    Alert.alert("Remove holiday?", `${label} will be a normal delivery day again. Plan end dates are recalculated.`, [
      { text: "Keep", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          try {
            await api.removeHoliday(id);
            await reload();
          } catch (err) {
            Alert.alert("Remove failed", err instanceof Error ? err.message : String(err));
          }
        },
      },
    ]);

  return (
    <Card>
      <SectionTitle>Kitchen holidays</SectionTitle>
      <Muted style={{ marginBottom: 10 }}>No diets are used on holidays; every affected plan's end date extends automatically.</Muted>
      <DateStepper label="Date" value={date} onChange={setDate} min={dash.today} />
      <Segmented<HolidayScope> value={scope} onChange={setScope} options={SCOPES} />
      <View style={{ height: 12 }} />
      <Field label="Reason (optional)" value={reason} onChangeText={setReason} placeholder="Diwali" maxLength={120} />
      <Button title="Add holiday" small icon="sunny-outline" onPress={add} loading={busy} />

      <View style={{ marginTop: 14 }}>
        {upcoming.length === 0 ? <Muted>No upcoming holidays.</Muted> : null}
        {upcoming.map((h) => {
          const label = `${formatDate(h.holiday_date, true)} (${h.meal_scope === "full_day" ? "full day" : h.meal_scope})`;
          return (
            <Row key={h.id} style={styles.holidayRow}>
              <Ionicons name="sunny" size={18} color={colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={styles.holidayTitle}>{label}</Text>
                {h.reason ? <Muted>{h.reason}</Muted> : null}
              </View>
              <Pressable onPress={() => remove(h.id, label)} accessibilityLabel={`Remove holiday ${label}`} style={styles.trash}>
                <Ionicons name="trash-outline" size={18} color={colors.red} />
              </Pressable>
            </Row>
          );
        })}
        {past.length > 0 ? (
          <View style={{ marginTop: 8 }}>
            <Banner tone="blue" icon="archive-outline" text={`${past.length} past holiday(s) kept for history.`} />
          </View>
        ) : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  holidayRow: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.graySoft },
  holidayTitle: { fontSize: 15, fontWeight: "700", color: colors.text },
  trash: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: 10, backgroundColor: colors.redSoft },
});
