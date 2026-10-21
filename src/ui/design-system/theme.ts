/**
 * ChoreScore V5 — first visual baseline, inspired by V1's clean teal,
 * generous typography and clearer information hierarchy.
 * Requires real screenshot review before final design acceptance.
 */
export const colors = {
  background: '#F7FBFC',
  surface: '#FFFFFF',
  surfaceAlt: '#F1FAEE',
  surfaceHighlight: '#E6F4F6',
  text: '#264653',
  textSecondary: '#457B9D',
  textMuted: '#576D79',
  textOnPrimary: '#FFFFFF',
  primary: '#257989',
  primaryLight: '#A8DADC',
  primaryDark: '#1E606B',
  balancePositive: '#197669',
  balanceNegative: '#B2412E',
  success: '#197669',
  error: '#B2412E',
  warning: '#925719',
  info: '#306C92',
  border: '#DCE7EA',
  divider: '#E7EEF0',
  chartColors: ['#257989', '#E9C46A', '#264653', '#2A9D8F', '#A8DADC', '#F4A261'],
};
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };
export const borderRadius = { sm: 10, md: 16, lg: 20, xl: 24 };
export const typography = {
  screenTitle: { fontSize: 30, lineHeight: 36, fontWeight: '800' as const, letterSpacing: -0.5, color: colors.text },
  sectionTitle: { fontSize: 19, fontWeight: '700' as const, letterSpacing: -0.2, color: colors.text },
  body: { fontSize: 16, fontWeight: '400' as const, lineHeight: 23, color: colors.text },
  bodyBold: { fontSize: 16, fontWeight: '700' as const, lineHeight: 23, color: colors.text },
  caption: { fontSize: 13, fontWeight: '400' as const, lineHeight: 19, color: colors.textSecondary },
  metric: { fontSize: 30, fontWeight: '800' as const, letterSpacing: -0.4, color: colors.text },
  metricUnit: { fontSize: 16, fontWeight: '500' as const, color: colors.textSecondary },
  balance: { fontSize: 21, fontWeight: '700' as const },
  tabLabel: { fontSize: 13, fontWeight: '600' as const, letterSpacing: 0.15 },
};
export const shadows = {
  small: { shadowColor: colors.text, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.055, shadowRadius: 3, elevation: 1 },
  medium: { shadowColor: colors.text, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.09, shadowRadius: 8, elevation: 2 },
};
export const theme = { colors, spacing, borderRadius, typography, shadows };
export type Theme = typeof theme;
