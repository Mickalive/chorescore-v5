/**
 * ChoreScore V4 — Invitation Screen
 *
 * Invitations are shared by link only, after the group exists. The link is
 * issued by the authenticated collaboration service and opened in the native share sheet through the injected
 * SystemShareGateway port (no fake share).
 *
 * Free for all. No premium gating. No plan limits.
 */

import React, { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import {
  View,
  StyleSheet,
  ScrollView,
  Alert,
  TouchableOpacity,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ScreenContainer } from '../src/ui/components/ScreenContainer';
import { Text } from '../src/ui/components/Text';
import { Button } from '../src/ui/components/Button';
import { Card } from '../src/ui/components/Card';
import { colors, spacing } from '../src/ui/design-system/theme';
import { useApp } from '../src/features/app/AppContext';
import { useI18n } from '../src/i18n';
import { Invitation, Member } from '../src/domain/entities';
import { createInvitation } from '../src/domain/services/invitationService';
import { buildInviteLink } from '../src/features/invitations/inviteLink';

export default function InviteScreen() {
  const router = useRouter();
  const { t, locale } = useI18n();
  const { currentHouseholdId, currentUser, repos, services, subscribeToDataChanges } = useApp();
  const collaborationAvailable = services.sync.isAvailable();
  const { memberId } = useLocalSearchParams<{ memberId?: string }>();
  const [existingInvitations, setExistingInvitations] = useState<Invitation[]>([]);
  const [targetMember, setTargetMember] = useState<Member | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const flowKey = JSON.stringify([currentHouseholdId, currentUser?.userId, memberId]);
  const activeFlow = useRef<string | null>(flowKey);
  const loadSequence = useRef(0);
  useLayoutEffect(() => {
    activeFlow.current = flowKey;
    setTargetMember(null);
    setExistingInvitations([]);
    return () => { activeFlow.current = null; };
  }, [flowKey]);

  const loadInvitations = useCallback(async () => {
    if (!currentHouseholdId) return;
    const sequence = ++loadSequence.current;
    const [invs, members] = await Promise.all([
      repos.invitations.getByHousehold(currentHouseholdId),
      repos.members.getByHousehold(currentHouseholdId),
    ]);
    if (activeFlow.current !== flowKey || sequence !== loadSequence.current) return;
    setTargetMember(members.find(member => member.id === memberId) ?? null);
    setExistingInvitations(invs.filter((inv: Invitation) =>
      inv.status === 'pending' && inv.invitedByUserId === currentUser?.userId &&
      Date.parse(inv.expiresAt) > Date.now() &&
      members.some(member => member.id === inv.targetMemberId && !member.userId),
    ));
  }, [currentHouseholdId, currentUser?.userId, memberId, repos, flowKey]);

  useEffect(() => {
    void loadInvitations().catch(() => {
      setExistingInvitations([]);
      setTargetMember(null);
    });
    return subscribeToDataChanges((type, groupId) => {
      if (groupId === currentHouseholdId && ['member', 'household'].includes(type)) {
        void loadInvitations().catch(() => {
          setExistingInvitations([]);
          setTargetMember(null);
        });
      }
    });
  }, [loadInvitations, subscribeToDataChanges, currentHouseholdId]);

  const shareLink = useCallback(async (token: string, groupName?: string) => {
    const link = buildInviteLink(token);
    await services.share.share({
      title: groupName ? t('invite.shareTitle', { group: groupName }) : t('invite.linkTitle'),
      message: groupName
        ? t('invite.shareMessage', { group: groupName, link })
        : t('invite.linkMessage', { link }),
      url: link,
    });
  }, [services, t]);

  const remoteInvitations =
    collaborationAvailable && typeof services.sync.createInvitation === 'function';

  const handleCreateAndShare = async () => {
    if (submittingRef.current || activeFlow.current !== flowKey) return;
    if (!remoteInvitations) {
      Alert.alert(t('invite.unavailableTitle'), t('invite.unavailableBody'));
      return;
    }
    if (!currentHouseholdId || !currentUser) return;
    if (!targetMember || targetMember.userId) {
      Alert.alert(t('invite.targetRequiredTitle'), t('invite.targetRequiredBody'));
      return;
    }
    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      const household = await repos.households.getById(currentHouseholdId);
      if (!household) throw new Error(t('invite.groupNotFound'));

      const members = await repos.members.getByHousehold(currentHouseholdId);
      const target = members.find(member => member.id === targetMember.id && !member.userId);
      if (!target || household.ownerId !== currentUser.userId) {
        throw new Error('Invitation target is no longer available');
      }
      const invitations = await repos.invitations.getByHousehold(currentHouseholdId);
      const existing = invitations.find(inv => inv.status === 'pending' &&
        inv.invitedByUserId === currentUser.userId && inv.targetMemberId === target.id &&
        Date.parse(inv.expiresAt) > Date.now() && /^[A-Za-z0-9_-]{43}$/.test(inv.linkToken));
      if (existing) {
        if (activeFlow.current !== flowKey) return;
        await shareLink(existing.linkToken, household.name);
        return;
      }
      const remote = await services.sync.createInvitation!(currentHouseholdId, target.id);

      const invData = createInvitation({
        household,
        invitedByUserId: currentUser.userId,
        targetMemberId: target.id,
      });
      const created = await repos.invitations.create({ ...invData, linkToken: remote.token, expiresAt: remote.expiresAt });
      if (activeFlow.current !== flowKey) return;
      await shareLink(created.linkToken, household.name);
      await loadInvitations();
    } catch {
      if (activeFlow.current === flowKey) Alert.alert(t('state.error'), t('invite.createError'));
    } finally {
      submittingRef.current = false;
      if (activeFlow.current !== null) setIsSubmitting(false);
    }
  };

  const revoke = (invitation: Invitation) => {
    if (!currentHouseholdId || !services.sync.revokeInvitation || revokingId) return;
    Alert.alert(
      t('invite.revokeConfirmTitle'),
      t('invite.revokeConfirmBody'),
      [
        { text: t('action.cancel'), style: 'cancel' },
        {
          text: t('invite.revoke'),
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setRevokingId(invitation.id);
              try {
                await services.sync.revokeInvitation!(currentHouseholdId, invitation.linkToken);
                await repos.invitations.updateStatus(invitation.id, 'revoked');
                await loadInvitations();
              } catch {
                Alert.alert(t('state.error'), t('invite.revokeError'));
              } finally {
                setRevokingId(null);
              }
            })();
          },
        },
      ],
    );
  };

  return (
    <ScreenContainer edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()}>
            <Text variant="caption" color={colors.textSecondary}>
              {`< ${t('action.back')}`}
            </Text>
          </TouchableOpacity>
          <Text variant="screenTitle">{t('invite.title')}</Text>
        </View>

        {!collaborationAvailable && (
          <Card style={styles.card}>
            <Text variant="sectionTitle">{t('invite.unavailableTitle')}</Text>
            <Text variant="body">{t('invite.unavailableBody')}</Text>
          </Card>
        )}
        <Card style={styles.card}>
          <Text variant="body" style={styles.hint}>
            {targetMember?.userId
              ? t('invite.alreadyJoined', { name: targetMember.name })
              : targetMember
              ? t('invite.targetedHint', { name: targetMember.name })
              : remoteInvitations
                ? t('invite.targetRequiredBody')
                : t('invite.linkOnlyHint')}
          </Text>
          <Button
            title={targetMember
              ? t('invite.createTargetedLink', { name: targetMember.name })
              : t('invite.createLink')}
            variant="primary"
            onPress={handleCreateAndShare}
            disabled={
              !remoteInvitations ||
              !!targetMember?.userId ||
              !currentHouseholdId ||
              isSubmitting ||
              (remoteInvitations && !targetMember)
            }
            loading={isSubmitting}
            style={styles.shareButton}
          />
        </Card>

        {existingInvitations.length > 0 && (
          <>
            <Text variant="sectionTitle" style={styles.sectionTitle}>
              {t('invite.pending')}
            </Text>
            {existingInvitations.map((inv) => (
              <Card key={inv.id} style={styles.inviteCard}>
                <View style={styles.inviteRow}>
                  <View style={styles.inviteInfo}>
                    <Text variant="body">
                      {inv.invitedEmail || t('invite.linkLabel')}
                    </Text>
                    <Text variant="caption" color={colors.textSecondary}>
                      {t('invite.createdOn', {
                        date: new Date(inv.createdAt).toLocaleDateString(
                          locale === 'fr' ? 'fr-FR' : 'en-US',
                        ),
                      })}
                    </Text>
                  </View>
                  <View style={styles.inviteActions}>
                    <Button
                      title={t('invite.reshare')}
                      variant="ghost"
                      size="small"
                      onPress={() => shareLink(inv.linkToken)}
                    />
                    {collaborationAvailable && services.sync.revokeInvitation && (
                      <Button
                        title={t('invite.revoke')}
                        variant="ghost"
                        size="small"
                        onPress={() => revoke(inv)}
                        loading={revokingId === inv.id}
                        disabled={revokingId !== null}
                        testID={`invite.revoke.${inv.id}`}
                      />
                    )}
                  </View>
                </View>
              </Card>
            ))}
          </>
        )}
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    paddingBottom: 40,
  },
  header: {
    marginBottom: spacing.xl,
    gap: spacing.sm,
  },
  card: {
    marginBottom: spacing.md,
  },
  hint: {
    marginBottom: spacing.md,
  },
  shareButton: {
    width: '100%',
  },
  sectionTitle: {
    marginBottom: spacing.md,
    marginTop: spacing.sm,
  },
  inviteCard: {
    marginBottom: spacing.sm,
  },
  inviteRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  inviteInfo: {
    flex: 1,
  },
  inviteActions: {
    alignItems: 'flex-end',
    gap: spacing.xs,
  },
});
