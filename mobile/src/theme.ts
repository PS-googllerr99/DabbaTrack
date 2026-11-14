/** Palette shared with the DabbaTrack PWA (static/styles.css). */
export const colors = {
  bg: "#FAF7F2",
  surface: "#FFFFFF",
  surfaceWarm: "#FFFBEB",
  text: "#111827",
  muted: "#6B7280",
  border: "#E5E7EB",
  primary: "#D97706",
  primaryDark: "#B45309",
  primarySoft: "#FEF3C7",
  green: "#059669",
  greenSoft: "#D1FAE5",
  red: "#DC2626",
  redSoft: "#FEE2E2",
  blue: "#2563EB",
  blueSoft: "#DBEAFE",
  purple: "#6D28D9",
  purpleSoft: "#EDE9FE",
  gray: "#4B5563",
  graySoft: "#F3F4F6",
};

export const radius = 16;

export const shadow = {
  shadowColor: "#111827",
  shadowOpacity: 0.06,
  shadowRadius: 10,
  shadowOffset: { width: 0, height: 2 },
  elevation: 2,
};

export const STATUS_STYLE: Record<string, { fg: string; bg: string; label: string }> = {
  pending: { fg: colors.gray, bg: colors.graySoft, label: "Pending" },
  confirmed: { fg: colors.blue, bg: colors.blueSoft, label: "Confirmed" },
  cancelled: { fg: colors.red, bg: colors.redSoft, label: "Cancelled" },
  paused: { fg: colors.purple, bg: colors.purpleSoft, label: "Paused" },
  delivered: { fg: colors.green, bg: colors.greenSoft, label: "Delivered" },
  holiday: { fg: colors.primaryDark, bg: colors.primarySoft, label: "Holiday" },
};
