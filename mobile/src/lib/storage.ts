import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

interface WebStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const webStorage = (): WebStorage | undefined =>
  (globalThis as unknown as { localStorage?: WebStorage }).localStorage;

/** SecureStore on device, localStorage on web (SecureStore has no web implementation). */
export async function getItem(key: string): Promise<string | null> {
  try {
    if (Platform.OS === "web") return webStorage()?.getItem(key) ?? null;
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

export async function setItem(key: string, value: string): Promise<void> {
  try {
    if (Platform.OS === "web") {
      webStorage()?.setItem(key, value);
      return;
    }
    await SecureStore.setItemAsync(key, value);
  } catch {
    // Storage failures are non-fatal: the session simply won't persist.
  }
}

export async function removeItem(key: string): Promise<void> {
  try {
    if (Platform.OS === "web") {
      webStorage()?.removeItem(key);
      return;
    }
    await SecureStore.deleteItemAsync(key);
  } catch {
    // ignore
  }
}

export async function getJson<T>(key: string): Promise<T | null> {
  const raw = await getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function setJson(key: string, value: unknown): Promise<void> {
  return setItem(key, JSON.stringify(value));
}
