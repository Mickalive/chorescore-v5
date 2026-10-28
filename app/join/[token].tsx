/** A new member signs in on this route so the invitation is never discarded.
 * The authenticated authority alone links the existing named member.
 */
import React, { useLayoutEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ScreenContainer } from '../../src/ui/components/ScreenContainer';
import { Text } from '../../src/ui/components/Text';
import { Button } from '../../src/ui/components/Button';
import { Card } from '../../src/ui/components/Card';
import { LoadingState, ErrorState } from '../../src/ui/components/States';
import { colors, spacing } from '../../src/ui/design-system/theme';
import { useApp } from '../../src/features/app/AppContext';
import { useI18n } from '../../src/i18n';
import { isValidInviteToken } from '../../src/features/invitations/inviteLink';

type Attempt = { key: string; status: 'accepting' | 'accepted' | 'error'; groupId?: string; message?: string; needsAuth?: boolean };

export default function JoinScreen() {
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const token = isValidInviteToken(params.token) ? params.token : null;
  const router = useRouter();
  const { t } = useI18n();
  const { currentUser, isLoading, households, services, signInWithProvider, loadHouseholds, setCurrentHouseholdId } = useApp();
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const signingInRef = useRef(false);
  const acceptingRef = useRef(false);
  const key = JSON.stringify([token, currentUser?.userId ?? null]);
  const activeFlow = useRef<string | null>(key);
  useLayoutEffect(() => {
    activeFlow.current = key;
    return () => { activeFlow.current = null; };
  }, [key]);
  const currentAttempt = attempt?.key === key ? attempt : null;
  const available = services.sync.isAvailable() && typeof services.sync.acceptInvitation === 'function';
  const groupName = households.find(group => group.id === currentAttempt?.groupId)?.name ?? t('join.sharedGroup');

  const handleSignIn = async () => {
    if (!token || !available || signingInRef.current || activeFlow.current !== key) return;
    signingInRef.current = true;
    setSigningIn(true);
    setAttempt(null);
    try {
      const signedIn = await signInWithProvider('google');
      if (signedIn && activeFlow.current === key) setAttempt(null);
    } catch {
      if (activeFlow.current === key) setAttempt({ key, status: 'error', message: 'state.genericError' });
    } finally {
      signingInRef.current = false;
      if (activeFlow.current !== null) setSigningIn(false);
    }
  };

  const handleAccept = async () => {
    if (!token || !currentUser || !available || signingInRef.current || acceptingRef.current || activeFlow.current !== key || typeof services.sync.acceptInvitation !== 'function') return;
    acceptingRef.current = true;
    setAccepting(true);
    setAttempt({ key, status: 'accepting' });
    try {
      const result = await services.sync.acceptInvitation(token);
      await loadHouseholds(currentUser.userId);
      if (activeFlow.current === key) setAttempt({ key, status: 'accepted', groupId: result.groupId });
    } catch (error) {
      if (activeFlow.current === key) {
        const status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 0;
        const message = status === 401 ? 'join.signInRequired'
          : [403,404,409,410].includes(status) ? 'join.unavailable'
          : status === 400 ? 'join.invalidLink' : 'join.acceptError';
        setAttempt({ key, status: 'error', message, needsAuth: status === 401 });
      }
    } finally {
      acceptingRef.current = false;
      if (activeFlow.current !== null) setAccepting(false);
    }
  };

  let content: React.ReactNode;
  if (isLoading) {
    content = <LoadingState message={t('join.verifying')} />;
  } else if (!token || !available) {
    content = <ErrorState title={t('state.errorTitle')} message={t(!token ? 'join.invalidLink' : 'invite.unavailableBody')}
      retryLabel={t('action.back')} onRetry={() => router.replace('/')} />;
  } else if (!currentUser) {
    content = <>
      <Text variant="body" style={styles.message}>{t('join.signInRequired')}</Text>
      {currentAttempt?.status === 'error' && <View accessibilityRole="alert">
        <Text variant="caption" color={colors.error}>{t(currentAttempt.message ?? 'state.genericError')}</Text>
      </View>}
      <Button title={t(signingIn ? 'state.loading' : 'auth.continueGoogle')} disabled={signingIn}
        onPress={handleSignIn} style={styles.button} />
    </>;
  } else if (currentAttempt?.status === 'accepted') {
    content = <>
      <Text variant="body" color={colors.success} style={styles.message}>{t('join.accepted', { group: groupName })}</Text>
      <Button title={t('join.goToGroup')} style={styles.button} onPress={() => {
        if (activeFlow.current !== key) return;
        setCurrentHouseholdId(currentAttempt.groupId!);
        router.replace('/add');
      }} />
    </>;
  } else if (currentAttempt?.status === 'accepting') {
    content = <LoadingState message={t('join.accepting')} />;
  } else if (currentAttempt?.status === 'error') {
    content = <>
      <ErrorState title={t('state.errorTitle')} message={t(currentAttempt.message ?? 'join.acceptError')}
        retryLabel={t('action.retry')} onRetry={() => setAttempt(null)} />
      {currentAttempt.needsAuth && <Button title={t(signingIn ? 'state.loading' : 'auth.continueGoogle')}
        disabled={signingIn} onPress={handleSignIn} style={styles.button} />}
    </>;
  } else {
    content = <>
      <Text variant="body" style={styles.message}>{t('join.invited', { group: t('join.sharedGroup') })}</Text>
      <Button title={t(accepting || signingIn ? 'state.loading' : 'join.accept')} disabled={accepting || signingIn}
        onPress={handleAccept} style={styles.button} />
    </>;
  }
  return <ScreenContainer edges={['top','bottom']}>
    <View style={styles.container}>
      <Text variant="screenTitle" style={styles.title}>{t('join.title')}</Text>
      <Card style={styles.card}>{content}</Card>
    </View>
  </ScreenContainer>;
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: spacing.xl },
  title: { textAlign: 'center', marginBottom: spacing.xxl },
  card: { padding: spacing.xl },
  message: { textAlign: 'center', marginBottom: spacing.xl },
  button: { marginTop: spacing.md },
});
