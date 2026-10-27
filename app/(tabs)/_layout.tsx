import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../../src/features/app/AppContext';
import Ionicons from '@expo/vector-icons/Ionicons';
/**
 * ChoreScore V4 — Tabs Layout
 *
 * Three exact tabs: Ajouter / Balances / À faire, localized FR/EN.
 * Bottom safe area is owned by React Navigation's tab bar.
 */

import React from 'react';
import { Redirect, Tabs } from 'expo-router';
import { colors } from '../../src/ui/design-system/theme';
import { useI18n } from '../../src/i18n';

export default function TabsLayout() {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  const { currentHouseholdId } = useApp();
  if (!currentHouseholdId) return <Redirect href="/" />;
  return (
    <Tabs key={currentHouseholdId}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.divider,
          borderTopWidth: 1,
          // Let React Navigation include the Android bottom safe-area inset.
          // A fixed height pushed labels underneath the system navigation bar.
          height: 60 + insets.bottom,
          paddingBottom: Math.max(4, insets.bottom),
          paddingTop: 4,
        },
        tabBarIconStyle: { height: 24 },
        tabBarLabelStyle: {
          fontSize: 12,
          lineHeight: 16,
          fontWeight: '500',
          letterSpacing: 0.2,
        },
        // V4-08: hide the tab bar while the keyboard is open so the form
        // keeps its full height on small screens.
        tabBarHideOnKeyboard: true,
        // V4-08: the scene background matches the warm cream canvas so no
        // white flash appears between tab transitions.
        sceneStyle: { backgroundColor: colors.background },
      }}
    >
      <Tabs.Screen
        name="add"
        options={{
          tabBarIcon: ({ color, size }) => <Ionicons name="add-circle-outline" size={size} color={color} />,
          title: t('tabs.add'),
          tabBarLabel: t('tabs.add'),
          tabBarAccessibilityLabel: t('tabs.add'),
        }}
      />
      <Tabs.Screen
        name="balances"
        options={{
          tabBarIcon: ({ color, size }) => <Ionicons name="swap-horizontal-outline" size={size} color={color} />,
          title: t('tabs.balances'),
          tabBarLabel: t('tabs.balances'),
          tabBarAccessibilityLabel: t('tabs.balances'),
        }}
      />
      <Tabs.Screen
        name="todos"
        options={{
          tabBarIcon: ({ color, size }) => <Ionicons name="checkbox-outline" size={size} color={color} />,
          title: t('tabs.todo'),
          tabBarLabel: t('tabs.todo'),
          tabBarAccessibilityLabel: t('tabs.todo'),
        }}
      />
    </Tabs>
  );
}
