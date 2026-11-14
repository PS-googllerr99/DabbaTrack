import { Ionicons } from "@expo/vector-icons";
import React from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  type TextProps,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { addDays, formatDate } from "../lib/format";
import { colors, radius, shadow, STATUS_STYLE } from "../theme";

export type IconName = React.ComponentProps<typeof Ionicons>["name"];

export function ScreenScroll({
  children,
  refreshing = false,
  onRefresh,
}: {
  children: React.ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.screenContent}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        onRefresh ? (
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} />
        ) : undefined
      }
    >
      {children}
    </ScrollView>
  );
}

export function Card({
  children,
  style,
  warm,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  warm?: boolean;
}) {
  return <View style={[styles.card, warm && { backgroundColor: colors.surfaceWarm }, style]}>{children}</View>;
}

export function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.sectionTitle}>{children}</Text>
      {right}
    </View>
  );
}

export function Muted({ style, ...props }: TextProps) {
  return <Text {...props} style={[styles.muted, style]} />;
}

type ButtonVariant = "primary" | "soft" | "ghost" | "danger" | "success";

export function Button({
  title,
  onPress,
  variant = "primary",
  icon,
  disabled,
  loading,
  small,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const palette: Record<ButtonVariant, { bg: string; fg: string; border?: string }> = {
    primary: { bg: colors.primary, fg: "#fff" },
    soft: { bg: colors.primarySoft, fg: colors.primaryDark },
    ghost: { bg: colors.surface, fg: colors.text, border: colors.border },
    danger: { bg: colors.redSoft, fg: colors.red },
    success: { bg: colors.green, fg: "#fff" },
  };
  const p = palette[variant];
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      onPress={onPress}
      disabled={inactive}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        { backgroundColor: p.bg, borderColor: p.border ?? p.bg, opacity: inactive ? 0.5 : pressed ? 0.85 : 1 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={p.fg} size="small" />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={small ? 15 : 18} color={p.fg} /> : null}
          <Text style={[styles.buttonText, small && { fontSize: 13 }, { color: p.fg }]} numberOfLines={1}>
            {title}
          </Text>
        </>
      )}
    </Pressable>
  );
}

export function Pill({ label, fg, bg }: { label: string; fg: string; bg: string }) {
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <Text style={[styles.pillText, { color: fg }]}>{label}</Text>
    </View>
  );
}

export function StatusPill({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? STATUS_STYLE.pending;
  return <Pill label={s.label} fg={s.fg} bg={s.bg} />;
}

export function Kpi({ label, value, tone = "primary" }: { label: string; value: string | number; tone?: keyof typeof KPI_TONES }) {
  const t = KPI_TONES[tone];
  return (
    <View style={[styles.kpi, { backgroundColor: t.bg }]}>
      <Text style={[styles.kpiValue, { color: t.fg }]}>{value}</Text>
      <Text style={styles.kpiLabel} numberOfLines={2}>
        {label}
      </Text>
    </View>
  );
}

const KPI_TONES = {
  primary: { bg: colors.primarySoft, fg: colors.primaryDark },
  blue: { bg: colors.blueSoft, fg: colors.blue },
  green: { bg: colors.greenSoft, fg: colors.green },
  red: { bg: colors.redSoft, fg: colors.red },
  purple: { bg: colors.purpleSoft, fg: colors.purple },
};

export function Field({ label, hint, ...props }: TextInputProps & { label: string; hint?: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput placeholderTextColor="#9CA3AF" {...props} style={[styles.input, props.multiline && styles.inputMulti, props.style]} />
      {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
    </View>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View style={styles.segment} accessibilityRole="tablist">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(o.value)}
            style={[styles.segmentItem, active && styles.segmentItemActive]}
          >
            <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[styles.chip, active && styles.chipActive]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

/** Dependency-free date picker: ◀ date ▶ with optional min date. */
export function DateStepper({
  label,
  value,
  onChange,
  min,
}: {
  label: string;
  value: string;
  onChange: (iso: string) => void;
  min?: string;
}) {
  const canBack = !min || value > min;
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.stepper}>
        <Pressable
          accessibilityLabel={`Previous day for ${label}`}
          disabled={!canBack}
          onPress={() => onChange(addDays(value, -1))}
          style={[styles.stepBtn, !canBack && { opacity: 0.3 }]}
        >
          <Ionicons name="chevron-back" size={20} color={colors.primaryDark} />
        </Pressable>
        <View style={{ flex: 1, alignItems: "center" }}>
          <Text style={styles.stepValue}>{formatDate(value, true)}</Text>
          <Text style={styles.stepSub}>{value}</Text>
        </View>
        <Pressable accessibilityLabel={`Next day for ${label}`} onPress={() => onChange(addDays(value, 1))} style={styles.stepBtn}>
          <Ionicons name="chevron-forward" size={20} color={colors.primaryDark} />
        </Pressable>
      </View>
    </View>
  );
}

export function Row({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.row, style]}>{children}</View>;
}

export function Banner({ text, tone = "primary", icon }: { text: string; tone?: "primary" | "red" | "blue" | "green"; icon?: IconName }) {
  const map = {
    primary: [colors.primarySoft, colors.primaryDark],
    red: [colors.redSoft, colors.red],
    blue: [colors.blueSoft, colors.blue],
    green: [colors.greenSoft, colors.green],
  } as const;
  const [bg, fg] = map[tone];
  return (
    <View style={[styles.banner, { backgroundColor: bg }]}>
      {icon ? <Ionicons name={icon} size={18} color={fg} /> : null}
      <Text style={[styles.bannerText, { color: fg }]}>{text}</Text>
    </View>
  );
}

export function LoadingView({ label = "Loading…" }: { label?: string }) {
  return (
    <View style={styles.center}>
      <ActivityIndicator color={colors.primary} size="large" />
      <Muted style={{ marginTop: 10 }}>{label}</Muted>
    </View>
  );
}

export function ErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={styles.center}>
      <Ionicons name="cloud-offline-outline" size={42} color={colors.muted} />
      <Text style={[styles.sectionTitle, { textAlign: "center", marginTop: 8 }]}>Can't load data</Text>
      <Muted style={{ textAlign: "center", marginVertical: 8 }}>{message}</Muted>
      <Button title="Retry" icon="refresh" onPress={onRetry} />
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  screenContent: { padding: 16, paddingBottom: 32, gap: 14 },
  card: { backgroundColor: colors.surface, borderRadius: radius, padding: 16, borderWidth: 1, borderColor: colors.border, ...shadow },
  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  sectionTitle: { fontSize: 17, fontWeight: "700", color: colors.text },
  muted: { color: colors.muted, fontSize: 13 },
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: 46,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
  buttonSmall: { minHeight: 36, paddingHorizontal: 12, borderRadius: 10 },
  buttonText: { fontSize: 15, fontWeight: "700" },
  pill: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999, alignSelf: "flex-start" },
  pillText: { fontSize: 12, fontWeight: "700" },
  kpi: { flexBasis: "47%", flexGrow: 1, borderRadius: 14, padding: 12 },
  kpiValue: { fontSize: 26, fontWeight: "800" },
  kpiLabel: { fontSize: 12, color: colors.gray, fontWeight: "600", marginTop: 2 },
  field: { marginBottom: 12 },
  fieldLabel: { fontSize: 13, fontWeight: "600", color: colors.gray, marginBottom: 6 },
  fieldHint: { fontSize: 12, color: colors.muted, marginTop: 4 },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: 16,
    color: colors.text,
  },
  inputMulti: { minHeight: 76, textAlignVertical: "top" },
  segment: { flexDirection: "row", backgroundColor: colors.graySoft, borderRadius: 12, padding: 4 },
  segmentItem: { flex: 1, paddingVertical: 9, alignItems: "center", borderRadius: 9 },
  segmentItemActive: { backgroundColor: colors.surface, ...shadow },
  segmentText: { fontSize: 14, fontWeight: "600", color: colors.muted },
  segmentTextActive: { color: colors.primaryDark },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 13, fontWeight: "600", color: colors.gray },
  chipTextActive: { color: "#fff" },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 4,
  },
  stepBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 10, backgroundColor: colors.primarySoft },
  stepValue: { fontSize: 16, fontWeight: "700", color: colors.text },
  stepSub: { fontSize: 11, color: colors.muted },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  banner: { flexDirection: "row", alignItems: "center", gap: 8, padding: 12, borderRadius: 12 },
  bannerText: { flex: 1, fontSize: 13, fontWeight: "600" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: colors.bg },
});
