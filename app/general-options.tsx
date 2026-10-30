/**
 * ChoreScore V4 — General Options
 *
 * Reachable from the bottom of the Groups root. Gathers profile, language,
 * notifications, privacy/data and legal, plus sign out. No premium or
 * subscription surface.
 */

import React, { useEffect, useState, useRef, useLayoutEffect } from 'react';
import { View, StyleSheet, TouchableOpacity, Switch, Alert, Linking } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { ScreenContainer } from '../src/ui/components/ScreenContainer';
import { Text } from '../src/ui/components/Text';
import { Card } from '../src/ui/components/Card';
import { Button } from '../src/ui/components/Button';
import { colors, spacing } from '../src/ui/design-system/theme';
import { useApp } from '../src/features/app/AppContext';
import { useI18n, SupportedLocale } from '../src/i18n';

const PRIVACY_CONSENT_KEY = 'chorescore.privacy.consent.v4';

function SettingRow({
  label,
  value,
  onPress,
  last,
  accessibilityLabel,
}: {
  label: string;
  value?: string;
  onPress?: () => void;
  last?: boolean;
  accessibilityLabel?: string;
}) {
  const content = (
    <View style={[styles.row, last && styles.rowLast]}>
      <Text variant="body">{label}</Text>
      {value ? (
        <Text variant="caption" color={colors.textSecondary}>
          {value}
        </Text>
      ) : null}
    </View>
  );
  if (!onPress) return content;
  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
    >
      {content}
    </TouchableOpacity>
  );
}

export default function GeneralOptionsScreen() {
  const router = useRouter();
  const { currentUser, signOut, services, households, repos } = useApp();
  const { t, locale, setLocale } = useI18n();
  const [privacyConsent, setPrivacyConsent] = useState(false);
  const researchAvailable = services.analytics?.isAvailable() === true;
  const [remindersEnabled, setRemindersEnabled] = useState<boolean | null>(null);
  const [savingReminders, setSavingReminders] = useState(false);
  const savingRemindersRef = useRef(false);
  const activeUser = useRef<string | null>(currentUser?.userId ?? null);
  useLayoutEffect(() => {
    activeUser.current = currentUser?.userId ?? null;
    return () => { activeUser.current = null; };
  }, [currentUser?.userId]);
  const [reminderError, setReminderError] = useState(false);

  useEffect(() => {
    let active = true;
    services.notifications.getEnabled().then(enabled => {
      if (active) setRemindersEnabled(enabled);
    }).catch(() => {
      if (active) Alert.alert(t('state.error'), t('options.notificationsError'));
    });
    services.notifications.getReconciliationError().then(failed => {
      if (active && failed) setReminderError(true);
    }).catch(() => undefined);
    AsyncStorage.getItem(PRIVACY_CONSENT_KEY)
      .then((value) => {
        if (!active) return;
        const enabled = researchAvailable && value === 'true';
        services.analytics?.setEnabled(enabled);
        setPrivacyConsent(enabled);
      })
      .catch(() => {
        // Preference is best-effort.
      });
    return () => { active = false; };
  }, [services.notifications, services.analytics, researchAvailable, t]);

  const handleRemindersChange = async (enabled: boolean) => {
    if (savingRemindersRef.current) return;
    const owner = currentUser?.userId ?? null;
    if (activeUser.current !== owner) return;
    savingRemindersRef.current = true;
    setSavingReminders(true);
    try {
      const todos = enabled && owner
        ? (await Promise.all(households.map(async household => (await repos.todos.getFutureReminders(household.id, new Date().toISOString()))
          .map(todo => ({ ...todo, householdId: household.id }))))).flat()
        : [];
      if (activeUser.current !== owner) return;
      await services.notifications.setEnabled(enabled, todos
        .filter(todo => todo.status !== 'completed' && todo.reminderAt && Date.parse(todo.reminderAt) > Date.now())
        .map(todo => ({
          title: t('todos.reminderNotificationTitle', { title: todo.title }),
          body: todo.notes || t('todos.reminderNotificationBody'),
          scheduledAt: todo.reminderAt!,
          data: { todoId: todo.id, householdId: todo.householdId, userId: owner! },
        })));
      if (activeUser.current !== owner) return;
      setRemindersEnabled(enabled);
      setReminderError(false);
    } catch {
      if (activeUser.current !== owner) return;
      setReminderError(true);
      setRemindersEnabled(await services.notifications.getEnabled().catch(() => false));
      Alert.alert(t('state.error'), t('options.notificationsError'));
    } finally {
      savingRemindersRef.current = false;
      setSavingReminders(false);
    }
  };

  const handleLocale = (next: SupportedLocale) => {
    setLocale(next);
  };

  const handleConsentChange = (next: boolean) => {
    if (!researchAvailable) return;
    services.analytics.setEnabled(next);
    setPrivacyConsent(next);
    AsyncStorage.setItem(PRIVACY_CONSENT_KEY, next ? 'true' : 'false').catch(() => {
      services.analytics.setEnabled(false);
      setPrivacyConsent(false);
      Alert.alert(t('state.error'), t('options.privacySaveError'));
    });
  };

  const openLegal = (doc: 'terms' | 'privacy' | 'notice') => {
    router.push(`/legal?doc=${doc}`);
  };

  const handleSignOut = async () => {
    await signOut();
    router.replace('/');
  };

  return (
    <ScreenContainer edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} accessibilityRole="button">
          <Text variant="caption" color={colors.textSecondary}>
            {'‹ '}
            {t('action.back')}
          </Text>
        </TouchableOpacity>
        <Text variant="screenTitle" style={styles.title}>
          {t('options.title')}
        </Text>
      </View>

      <Text variant="caption" style={styles.sectionLabel}>
        {t('options.profile')}
      </Text>
      <Card style={styles.card}>
        <SettingRow
          label={currentUser?.displayName ?? t('options.profileNotSignedIn')}
          value={currentUser?.email}
          last
        />
      </Card>

      <Text variant="caption" style={styles.sectionLabel}>
        {t('options.language')}
      </Text>
      <Card style={styles.card}>
        <TouchableOpacity
          onPress={() => handleLocale('fr')}
          accessibilityRole="button"
          accessibilityState={{ selected: locale === 'fr' }}
        >
          <View style={styles.row}>
            <Text variant="body">{t('options.languageFrench')}</Text>
            {locale === 'fr' ? <Text variant="body" color={colors.primary}>{'✓'}</Text> : null}
          </View>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => handleLocale('en')}
          accessibilityRole="button"
          accessibilityState={{ selected: locale === 'en' }}
        >
          <View style={[styles.row, styles.rowLast]}>
            <Text variant="body">{t('options.languageEnglish')}</Text>
            {locale === 'en' ? <Text variant="body" color={colors.primary}>{'✓'}</Text> : null}
          </View>
        </TouchableOpacity>
      </Card>

      <Text variant="caption" style={styles.sectionLabel}>
        {t('options.notifications')}
      </Text>
      <Card style={styles.card}>
        {services.notifications.isAvailable() ? <>
          <View style={[styles.row, styles.rowLast]}>
            <Text variant="body" style={styles.consentLabel}>{t('options.remindersEnabled')}</Text>
            <Switch testID="options.remindersEnabled"
              accessibilityLabel={t('options.remindersEnabled')}
              value={remindersEnabled === true}
              disabled={savingReminders || remindersEnabled === null}
              onValueChange={handleRemindersChange}
              trackColor={{ false: colors.border, true: colors.primaryLight }}
              thumbColor={remindersEnabled ? colors.primary : colors.surface} />
          </View>
          <Text variant="caption" style={styles.privacyBody}>{t('options.remindersHelp')}</Text>
          {reminderError ? <>
            <View accessibilityRole="alert"><Text variant="caption">{t('options.notificationsError')}</Text></View>
            <Button title={t('action.retry')} variant="secondary" disabled={savingReminders}
              onPress={() => { void handleRemindersChange(remindersEnabled === true); }} />
          </> : null}
          <Button title={t('options.notificationSettings')} variant="ghost"
            onPress={() => { void Linking.openSettings().catch(() => Alert.alert(t('state.error'), t('options.notificationsError'))); }} />
        </> : <SettingRow label={t('options.notificationsUnavailable')} last />}
      </Card>

      <Text variant="caption" style={styles.sectionLabel}>
        {t('options.privacy')}
      </Text>
      <Card style={styles.card}>
        <Text variant="bodyBold" style={styles.privacyTitle}>
          {t('options.privacyDataTitle')}
        </Text>
        <Text variant="caption" style={styles.privacyBody}>
          {t('options.privacyBody')}
        </Text>
        <View style={[styles.row, styles.rowLast, styles.consentRow]}>
          <Text variant="body" style={styles.consentLabel}>
            {t('options.privacyConsent')}
          </Text>
          <Switch
            testID="options.privacyConsent"
            accessibilityLabel={t('options.privacyConsent')}
            disabled={!researchAvailable}
            value={privacyConsent}
            onValueChange={handleConsentChange}
            trackColor={{ false: colors.border, true: colors.primaryLight }}
            thumbColor={privacyConsent ? colors.primary : colors.surface}
          />
        </View>
      </Card>

      <Text variant="caption" style={styles.sectionLabel}>
        {t('options.legal')}
      </Text>
      <Card style={styles.card}>
        <SettingRow
          label={t('options.legalTerms')}
          accessibilityLabel={t('legal.openTerms')}
          onPress={() => openLegal('terms')}
        />
        <SettingRow
          label={t('options.legalPrivacy')}
          accessibilityLabel={t('legal.openPrivacy')}
          onPress={() => openLegal('privacy')}
        />
        <SettingRow
          label={t('options.legalNotice')}
          accessibilityLabel={t('legal.openNotice')}
          onPress={() => openLegal('notice')}
          last
        />
      </Card>

      <View style={styles.signOut}>
        <Button title={t('options.signOut')} variant="ghost" onPress={handleSignOut} />
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: {
    marginBottom: spacing.xl,
  },
  title: {
    marginTop: spacing.md,
  },
  sectionLabel: {
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  card: {
    paddingVertical: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    gap: spacing.md,
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  privacyTitle: {
    marginTop: spacing.md,
  },
  privacyBody: {
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
  },
  consentRow: {
    marginTop: spacing.xs,
  },
  consentLabel: {
    flex: 1,
  },
  signOut: {
    marginTop: spacing.xxl,
    alignItems: 'center',
  },
});
