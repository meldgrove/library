"use client";

import { AppearanceCard } from "@meldgrove/ui/settings-cards";
import { useThemePreference } from "@meldgrove/ui/theme";

/** "Appearance", kept in this browser: the same choice as in the frame's user menu. */
export function AppearanceSettings() {
  const [theme, setTheme] = useThemePreference();
  return <AppearanceCard value={theme} onChange={setTheme} />;
}
