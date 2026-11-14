import { Ionicons } from "@expo/vector-icons";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors } from "../theme";
import type { IconName } from "./ui";

export interface TabDef<K extends string> {
  key: K;
  label: string;
  icon: IconName;
  badge?: number;
}

export function TabShell<K extends string>({
  title,
  subtitle,
  tabs,
  active,
  onChange,
  onOpenSettings,
  headerExtra,
  children,
}: {
  title: string;
  subtitle?: string;
  tabs: TabDef<K>[];
  active: K;
  onChange: (k: K) => void;
  onOpenSettings: () => void;
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={styles.subtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {headerExtra}
        <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={onOpenSettings} style={styles.headerBtn}>
          <Ionicons name="settings-outline" size={22} color={colors.primaryDark} />
        </Pressable>
      </View>

      <View style={{ flex: 1 }}>{children}</View>

      <View style={[styles.tabBar, { paddingBottom: Math.max(insets.bottom, 8) }]} accessibilityRole="tablist">
        {tabs.map((t) => {
          const isActive = t.key === active;
          const tint = isActive ? colors.primary : colors.muted;
          return (
            <Pressable
              key={t.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive }}
              accessibilityLabel={t.label}
              onPress={() => onChange(t.key)}
              style={styles.tab}
            >
              <View>
                <Ionicons name={t.icon} size={23} color={tint} />
                {t.badge ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{t.badge > 99 ? "99+" : t.badge}</Text>
                  </View>
                ) : null}
              </View>
              <Text style={[styles.tabLabel, { color: tint }]} numberOfLines={1}>
                {t.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 12,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: { fontSize: 20, fontWeight: "800", color: colors.text },
  subtitle: { fontSize: 13, color: colors.muted, marginTop: 1 },
  headerBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primarySoft,
  },
  tabBar: {
    flexDirection: "row",
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 8,
  },
  tab: { flex: 1, alignItems: "center", gap: 2 },
  tabLabel: { fontSize: 11, fontWeight: "600" },
  badge: {
    position: "absolute",
    top: -4,
    right: -10,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: colors.red,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { color: "#fff", fontSize: 10, fontWeight: "800" },
});
