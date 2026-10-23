import { StyleSheet, Text, View } from 'react-native';
import { COLORS, SPACING } from './theme';

type Props = {
  eyebrow?: string;
  title: string;
  subtitle: string;
};

export function ScreenHeader({ eyebrow, title, subtitle }: Props) {
  return (
    <View style={styles.container}>
      {eyebrow === undefined ? null : <Text style={styles.eyebrow}>{eyebrow}</Text>}
      <Text accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
      <Text style={styles.subtitle}>{subtitle}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: SPACING.lg,
  },
  eyebrow: {
    color: COLORS.success,
    fontWeight: '800',
    fontSize: 12,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: SPACING.xs,
  },
  title: {
    color: COLORS.textPrimary,
    fontSize: 30,
    lineHeight: 36,
    fontWeight: '800',
  },
  subtitle: {
    color: COLORS.textSecondary,
    fontSize: 15,
    lineHeight: 22,
    marginTop: SPACING.xs,
  },
});
