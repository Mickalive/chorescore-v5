import { GroupCard } from '../src/features/groups/GroupCard';
import { GroupsHeader } from '../src/features/groups/GroupsHeader';
import { firebaseAuthConfig } from '../src/infrastructure/cloud/FirebaseAuthAdapter';
/**
 * ChoreScore V4 — Root Index Screen (Groups)
 *
 * Opens a local-first account without third-party login.
 * Groups, tasks, expenses and balances are stored on the device.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, StyleSheet, TouchableOpacity, Alert, TextInput } from 'react-native';
import { useRouter } from 'expo-router';
import { ScreenContainer } from '../src/ui/components/ScreenContainer';
import { Text } from '../src/ui/components/Text';
import { Button } from '../src/ui/components/Button';
import { LoadingState, EmptyState, PersistenceBanner, InlineNotice } from '../src/ui/components/States';
import { colors, spacing, borderRadius } from '../src/ui/design-system/theme';
import { useApp } from '../src/features/app/AppContext';
import { useI18n } from '../src/i18n';
import { ContributionUnit, Household } from '../src/domain/entities';

export default function HomeScreen() {
  const router = useRouter();
  const { t } = useI18n();
  const {
    currentUser,
    isLoading,
    persistenceDegraded,
    services,
    signIn,
    signInWithProvider,
    households,
    loadHouseholds,
    createHousehold,
    setCurrentHouseholdId,
    getMembersForHousehold,
  } = useApp();
  const [startingLocal, setStartingLocal] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [memberNames, setMemberNames] = useState<string[]>([]);
  const [memberInput, setMemberInput] = useState('');
  const [contributionUnit, setContributionUnit] = useState<ContributionUnit>('minutes');
  const creatingRef = useRef(false);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [memberCounts, setMemberCounts] = useState<Record<string, number>>({});

  const load = useCallback(async () => {
    if (currentUser) {
      await loadHouseholds();
    }
  }, [currentUser, loadHouseholds]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    if (households.length === 0) {
      setMemberCounts({});
      return;
    }
    Promise.all(
      households.map(async (group) => {
        try {
          const members = await getMembersForHousehold(group.id);
          return [group.id, members.length] as const;
        } catch {
          return [group.id, 0] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setMemberCounts(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [households, getMembersForHousehold]);

  const openHousehold = async (id: string) => {
    setCurrentHouseholdId(id);
    router.push('/add');
  };

  const handleCreateHousehold = async () => {
    if (!newGroupName.trim() || creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    try {
      const names = memberInput.trim() ? [...memberNames, memberInput.trim()] : memberNames;
      await createHousehold(newGroupName.trim(), names, contributionUnit);
      setNewGroupName('');
      setMemberNames([]);
      setMemberInput('');
      setShowCreate(false);
    } catch {
      Alert.alert(t('state.error'), t('groups.createError'));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const handleAddMemberName = () => {
    const name = memberInput.trim();
    if (!name) return;
    setMemberNames((current) => [...current, name]);
    setMemberInput('');
  };

  const handleRemoveMemberName = (index: number) => {
    setMemberNames((current) => current.filter((_, i) => i !== index));
  };

  const handleCloseCreate = () => {
    setShowCreate(false);
    setNewGroupName('');
    setMemberNames([]);
    setMemberInput('');
  };

  const handleStartLocal = async () => {
    setStartingLocal(true);
    try {
      if (firebaseAuthConfig()) {
        const signedIn = await signInWithProvider('google');
        if (!signedIn) return;
      } else {
        await signIn('', '');
      }
    } catch {
      Alert.alert(t('state.error'), t('state.genericError'));
    } finally {
      setStartingLocal(false);
    }
  };

  if (isLoading) {
    return (
      <ScreenContainer edges={['top', 'bottom']}>
        <LoadingState message={t('state.loading')} />
      </ScreenContainer>
    );
  }

  // Offline sign-in fallback while automatic session restoration completes.
  if (!currentUser) {
    return (
      <ScreenContainer edges={['top', 'bottom']}>
        <View style={styles.header}>
          <Text variant="screenTitle">{t('app.name')}</Text>
          <Text variant="caption">{t('app.tagline')}</Text>
        </View>

        <View style={styles.signInContainer}>
          <Text variant="caption">{t(firebaseAuthConfig() ? 'app.tagline' : 'auth.localInfo')}</Text>
          <Button
            title={startingLocal ? t('state.loading') : t(firebaseAuthConfig() ? 'auth.continueGoogle' : 'auth.localContinue')}
            variant="primary"
            onPress={handleStartLocal}
            disabled={startingLocal}
            style={styles.fullWidth}
          />
        </View>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer edges={['top', 'bottom']}>
      <GroupsHeader groupCount={households.length}
        memberCount={Object.values(memberCounts).reduce((sum, count) => sum + count, 0)} />

      <PersistenceBanner visible={persistenceDegraded} message={t('state.persistenceBody')} />
      {!services.sync.isAvailable() && <InlineNotice message={t('auth.localInfo')} style={{ marginBottom: spacing.lg }} />}

      <View style={styles.list}>
        {households.length === 0 ? (
          <EmptyState
            title={t('groups.emptyTitle')}
            body={t('groups.emptyBody')}
          />
        ) : (
          households.map((item: Household) => (
            <GroupCard key={item.id} group={item} memberCount={memberCounts[item.id]}
              onOpen={() => openHousehold(item.id)}
              onOptions={() => { setCurrentHouseholdId(item.id); router.push('/group-options'); }} />
          ))
        )}
      </View>

      {showCreate ? (
        <View style={styles.createForm}>
          <Text variant="sectionTitle">{t('groups.create')}</Text>
          <View style={styles.inputGroup}>
            <Text variant="caption">{t('groups.nameLabel')}</Text>
            <TextInput
              testID="groups.nameInput"
              autoFocus
              style={styles.input}
              value={newGroupName}
              onChangeText={setNewGroupName}
              placeholder={t('groups.namePlaceholder')}
              placeholderTextColor={colors.textMuted}
            />
          </View>

          <View style={styles.inputGroup}>
            <Text variant="caption">{t('groupOptions.unit')}</Text>
            <View style={styles.memberInputRow}>
              {(['minutes', 'points'] as const).map((unit) => (
                <Button key={unit} title={t(unit === 'minutes' ? 'unit.minutes' : 'unit.points')}
                  variant={contributionUnit === unit ? 'primary' : 'secondary'}
                  onPress={() => setContributionUnit(unit)} testID={`groups.unit.${unit}`} />
              ))}
            </View>
          </View>
          <View style={styles.inputGroup}>
            <Text variant="caption">{t('groups.membersLabel')}</Text>
            <View style={styles.memberInputRow}>
              <TextInput
                testID="groups.memberInput"
                style={[styles.input, styles.memberInput]}
                value={memberInput}
                onChangeText={setMemberInput}
                placeholder={t('groups.memberNamePlaceholder')}
                placeholderTextColor={colors.textMuted}
                onSubmitEditing={handleAddMemberName}
                submitBehavior="blurAndSubmit"
                returnKeyType="done"
                maxLength={60}
              />
              <Button
                title={t('action.add')}
                variant="secondary"
                size="small"
                onPress={handleAddMemberName}
                disabled={!memberInput.trim()}
              />
            </View>
            {memberNames.length > 0 && (
              <View style={styles.memberChips}>
                {memberNames.map((memberName, index) => (
                  <TouchableOpacity
                    key={`${memberName}-${index}`}
                    onPress={() => handleRemoveMemberName(index)}
                    style={styles.memberChip}
                    accessibilityRole="button"
                    accessibilityLabel={t('groups.removeMember', { name: memberName })}
                  >
                    <Text variant="caption">{memberName}</Text>
                    <Text variant="caption" color={colors.textMuted}>{'  ×'}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
            <Text variant="caption" color={colors.textSecondary} style={styles.memberHelp}>
              {t('groups.membersHelp')}
            </Text>
          </View>

          <View style={styles.createActions}>
            <Button
              title={t('action.create')}
              variant="primary"
              onPress={handleCreateHousehold}
              disabled={!newGroupName.trim() || creating}
              testID="groups.createButton"
            />
            <Button
              title={t('action.cancel')}
              variant="ghost"
              onPress={handleCloseCreate}
              size="small"
            />
          </View>
        </View>
      ) : (
        <View style={styles.actions}>
          <Button
            title={t('groups.create')}
            variant="primary"
            onPress={() => setShowCreate(true)}
            testID="groups.newButton"
          />
        </View>
      )}

      <TouchableOpacity
        onPress={() => router.push('/general-options')}
        style={styles.generalOptions}
        accessibilityRole="button"
      >
        <Text variant="caption" color={colors.textSecondary}>
          {t('groups.generalOptions')}
        </Text>
      </TouchableOpacity>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: {
    marginBottom: spacing.xl,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  signInContainer: {
    alignItems: 'center',
    paddingVertical: spacing.xxl,
    gap: spacing.md,
  },
  inputGroup: {
    marginBottom: spacing.md,
  },
  memberInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  memberInput: {
    flex: 1,
  },
  memberChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  memberChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    minHeight: 48,
    borderRadius: borderRadius.sm,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  memberHelp: {
    marginTop: spacing.sm,
  },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    padding: spacing.md,
    marginTop: spacing.xs,
    fontSize: 16,
    color: colors.text,
  },
  fullWidth: {
    width: '100%',
  },
  list: {
    gap: spacing.md,
  },
  actions: {
    marginTop: spacing.xl,
    alignItems: 'center',
  },
  createForm: {
    marginTop: spacing.lg,
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  createActions: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  generalOptions: {
    marginTop: spacing.xxl,
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
});
