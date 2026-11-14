import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import type { MealType } from "../api/types";

export const MEAL_CHANNEL_ID = "meal-prompts";

export interface MealPromptData {
  type: "meal_prompt";
  meal_type: MealType;
  meal_date: string;
  menu: string;
  cutoff: string;
  customer_id?: number;
}

/** Show pushes as banners even while the app is open (we also open the in-app pop-up). */
export function configureNotificationHandler(): void {
  if (Platform.OS === "web") return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

export function parseMealPrompt(data: unknown): MealPromptData | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type !== "meal_prompt") return null;
  if (d.meal_type !== "lunch" && d.meal_type !== "dinner") return null;
  return {
    type: "meal_prompt",
    meal_type: d.meal_type,
    meal_date: typeof d.meal_date === "string" ? d.meal_date : "",
    menu: typeof d.menu === "string" ? d.menu : "",
    cutoff: typeof d.cutoff === "string" ? d.cutoff : "",
    customer_id: typeof d.customer_id === "number" ? d.customer_id : undefined,
  };
}

export type PushRegistration = { token: string } | { token: null; reason: string };

/**
 * Ask for notification permission and fetch this device's Expo push token.
 * Never throws: returns a human-readable reason when push is unavailable
 * (simulator, web, Expo Go on Android, permission denied, missing EAS projectId).
 */
export async function registerForPushToken(): Promise<PushRegistration> {
  if (Platform.OS === "web") return { token: null, reason: "Push notifications are not supported on web." };
  if (!Device.isDevice) return { token: null, reason: "Push notifications need a physical phone." };

  try {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync(MEAL_CHANNEL_ID, {
        name: "Meal confirmation prompts",
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 200, 120, 200],
        lightColor: "#D97706",
      });
    }

    const existing = await Notifications.getPermissionsAsync();
    let granted = existing.granted;
    if (!granted && existing.canAskAgain) {
      granted = (await Notifications.requestPermissionsAsync()).granted;
    }
    if (!granted) return { token: null, reason: "Notification permission was not granted." };

    const projectId =
      (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ??
      Constants.easConfig?.projectId;
    if (!projectId) {
      return { token: null, reason: "Missing EAS projectId. Run `eas init` in mobile/ and rebuild." };
    }

    const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
    return { token: data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { token: null, reason: `Push setup failed: ${msg}` };
  }
}
