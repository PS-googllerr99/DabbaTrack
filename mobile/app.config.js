// Dynamic layer over app.json (Expo passes app.json in as `config`).
// Production builds (APP_ENV=production, set in eas.json) only allow HTTPS: plain-HTTP traffic is blocked,
// so PINs and tokens can't travel unencrypted. Dev and preview builds keep HTTP for LAN testing.
module.exports = ({ config }) => {
  if (process.env.APP_ENV !== "production") return config;

  // A production build without an https:// API URL would ship an app that can't reach any server.
  const apiUrl = (process.env.EXPO_PUBLIC_API_URL || "").trim();
  if (!/^https:\/\/[^\s/]+/i.test(apiUrl)) {
    throw new Error(
      "Production build needs EXPO_PUBLIC_API_URL set to your https:// server, e.g.\n" +
        "  eas env:create --environment production --name EXPO_PUBLIC_API_URL --value https://tiffin.example.com --visibility plaintext\n" +
        `(current value: ${apiUrl ? JSON.stringify(apiUrl) : "not set"})`,
    );
  }

  const plugins = (config.plugins ?? []).map((plugin) => {
    if (Array.isArray(plugin) && plugin[0] === "expo-build-properties") {
      const opts = plugin[1] ?? {};
      return ["expo-build-properties", { ...opts, android: { ...(opts.android ?? {}), usesCleartextTraffic: false } }];
    }
    return plugin;
  });

  const infoPlist = { ...(config.ios?.infoPlist ?? {}) };
  delete infoPlist.NSAppTransportSecurity;

  return { ...config, plugins, ios: { ...config.ios, infoPlist } };
};
