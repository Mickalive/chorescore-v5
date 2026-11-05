import { ScreenContainer } from '../src/ui/components/ScreenContainer';
import { LoadingState } from '../src/ui/components/States';
/**
 * ChoreScore V4 — Root Layout
 *
 * Expo Router root layout with the warm V2 design system, i18n and app context.
 * No premium, no chrono, no demo entry in the normal build.
 */

import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider, useApp } from '../src/features/app/AppContext';
import { I18nProvider, useI18n } from '../src/i18n';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <I18nProvider>
        <AppProvider>
          <AppNavigation />
        </AppProvider>
      </I18nProvider>
    </SafeAreaProvider>
  );
}

/** Every route waits for the persisted identity and scoped repositories. Direct
 * navigation/reload must not flash an unsigned profile or mount a stale group.
 */
function AppNavigation() {
  const { isLoading } = useApp();
  const { t } = useI18n();
  if (isLoading) {
    return (
      <ScreenContainer edges={['top', 'bottom']}>
        <LoadingState message={t('state.loading')} />
      </ScreenContainer>
    );
  }
  return (
    <>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="general-options" />
        <Stack.Screen name="legal" />
        <Stack.Screen name="group-options" />
        <Stack.Screen name="invite" />
        <Stack.Screen name="edit-entry" />
        <Stack.Screen name="join/[token]" />
      </Stack>
    </>
  );
}
