import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Modal, StyleSheet, Text, View } from "react-native";

import type { MealType } from "../api/types";
import { formatDate, formatTime, titleCase } from "../lib/format";
import { colors } from "../theme";
import { Button, Muted } from "./ui";

export interface MealPrompt {
  meal_type: MealType;
  meal_date: string;
  menu: string;
  cutoff: string;
  locked?: boolean;
  lockReason?: string;
}

/** In-app "Do you want lunch today?" confirmation, opened from a push or a provider broadcast. */
export function MealPromptModal({
  prompt,
  onAnswer,
  onDismiss,
}: {
  prompt: MealPrompt | null;
  onAnswer: (prompt: MealPrompt, wantsTiffin: boolean) => Promise<void>;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState<"yes" | "no" | null>(null);

  const answer = async (wants: boolean) => {
    if (!prompt) return;
    setBusy(wants ? "yes" : "no");
    try {
      await onAnswer(prompt, wants);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal visible={!!prompt} transparent animationType="fade" onRequestClose={onDismiss}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} accessibilityViewIsModal>
          {prompt ? (
            <>
              <View style={styles.iconWrap}>
                <Ionicons name={prompt.meal_type === "lunch" ? "sunny" : "moon"} size={30} color={colors.primary} />
              </View>
              <Text style={styles.title}>{titleCase(prompt.meal_type)} today?</Text>
              <Muted style={{ textAlign: "center" }}>
                {formatDate(prompt.meal_date, true)}
                {prompt.cutoff ? ` · confirm before ${formatTime(prompt.cutoff)}` : ""}
              </Muted>
              <View style={styles.menuBox}>
                <Text style={styles.menuLabel}>MENU</Text>
                <Text style={styles.menuText}>{prompt.menu || "Menu not published yet"}</Text>
              </View>
              {prompt.locked ? (
                <Text style={styles.locked}>{prompt.lockReason || "Cutoff has passed for this meal."}</Text>
              ) : (
                <View style={styles.actions}>
                  <Button
                    title="Cancel meal"
                    variant="danger"
                    icon="close-circle"
                    loading={busy === "no"}
                    disabled={busy !== null}
                    onPress={() => answer(false)}
                    style={{ flex: 1 }}
                  />
                  <Button
                    title="Yes, send it"
                    variant="success"
                    icon="checkmark-circle"
                    loading={busy === "yes"}
                    disabled={busy !== null}
                    onPress={() => answer(true)}
                    style={{ flex: 1 }}
                  />
                </View>
              )}
              <Button title="Decide later" variant="ghost" small onPress={onDismiss} disabled={busy !== null} />
            </>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(17,24,39,0.45)", justifyContent: "center", padding: 20 },
  sheet: { backgroundColor: colors.surface, borderRadius: 22, padding: 20, gap: 12 },
  iconWrap: {
    alignSelf: "center",
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.primarySoft,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { fontSize: 22, fontWeight: "800", color: colors.text, textAlign: "center" },
  menuBox: { backgroundColor: colors.surfaceWarm, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: colors.primarySoft },
  menuLabel: { fontSize: 11, fontWeight: "800", color: colors.primaryDark, letterSpacing: 1 },
  menuText: { fontSize: 16, color: colors.text, marginTop: 4, lineHeight: 22 },
  actions: { flexDirection: "row", gap: 10 },
  locked: { textAlign: "center", color: colors.red, fontWeight: "600" },
});
