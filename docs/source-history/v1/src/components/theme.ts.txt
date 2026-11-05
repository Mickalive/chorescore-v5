export const COLORS = {
  primary: '#A8DADC',
  secondary: '#F1FAEE',
  accent: '#E9C46A',
  success: '#2A9D8F',
  warning: '#F4A261',
  error: '#E76F51',
  // DRC-05 : fonds teintés doux, aucun blanc dominant. background est le fond
  // dominant de l'écran (Screen/SafeAreaView) ; surface est le fond des
  // cartes ; surfaceAlt sert aux zones secondaires. Les teintes chaudes
  // (cream/beige) donnent un feel-good chaleureux et contemporain. Les
  // contrastes AA (≥ 4,5:1) sont vérifiés par theme-contrast.test.ts.
  background: '#F7F2EB',
  surface: '#FFFDF9',
  surfaceAlt: '#F6F2ED',
  textPrimary: '#264653',
  // DRC-05 (MOB-CYCLE32961708279-SEG) : assombri de #457B9D vers #3C6E8E
  // pour atteindre ≥ 4,5:1 (AA) sur chaque fond réellement employé —
  // background #F7F2EB ≈ 4,95:1, surface #FFFDF9 ≈ 5,43:1, surfaceAlt
  // #F6F2ED ≈ 4,95:1. Mesure vérifiée par tests/theme-contrast.test.ts.
  textSecondary: '#3C6E8E',
  // DRC-05 (passe contraste textMuted) : jeton ajusté pour ≥ 4,5:1 (AA) sur
  // chaque fond réellement employé — background #F7F2EB ≈ 4,71:1,
  // surface #FFFDF9 ≈ 5,16:1, surfaceAlt #F6F2ED ≈ 4,71:1.
  // Mesure vérifiée par tests/theme-contrast.test.ts.
  textMuted: '#56707C',
  textDisabled: '#9BAEB7',
  border: '#DCE7EA',
  shadow: '#264653',
} as const;

export const SPACING = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

export const RADIUS = {
  sm: 10,
  md: 16,
  lg: 24,
  pill: 999,
} as const;
