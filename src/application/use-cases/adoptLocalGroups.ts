import { SecureStorageGateway } from '../ports';
import { AllRepositories } from '../../infrastructure/repositories/RepositoryFactory';
import { createSyncRecordForEntity } from '../../infrastructure/sync/SyncMaterializer';

/** Link this device's unpublished groups when its owner first signs into Google.
 * The secure local identity is the authority, never a name or an arbitrary DB
 * owner. Published groups and other accounts are deliberately left untouched.
 * Member IDs and all financial/task history remain exactly as recorded.
 */
export async function adoptLocalGroups(
  repos: AllRepositories, storage: SecureStorageGateway, authenticatedUserId: string,
  getCurrentUserId: () => string | null,
): Promise<void> {
  if (!authenticatedUserId || authenticatedUserId.startsWith('local-')) return;
  const localId = await storage.getItem('chorescore.auth.local-identity');
  if (!localId?.startsWith('local-')) return;
  await repos.withTransaction(async () => {
    const assertCurrentAccount = () => {
      if (getCurrentUserId() !== authenticatedUserId) throw new Error('Account changed during local group migration');
    };
    assertCurrentAccount();
    const memberships = await repos.memberships.getByUser(localId);
    for (const membership of memberships) {
      if (membership.role !== 'OWNER') continue;
      const id = membership.householdId;
      const group = await repos.households.getById(id);
      if (!group || group.ownerId !== localId) continue;
      if ((await repos.syncState.getGroupState(id))?.remoteKnown ||
          await repos.syncState.getPendingMutation(id)) continue;
      const members = await repos.members.getByHousehold(id);
      const owners = members.filter(member => member.userId === localId);
      const groupMemberships = await repos.memberships.getByHousehold(id);
      if (owners.length !== 1 || groupMemberships.length !== 1 ||
          members.some(member => member.userId && member.userId !== localId)) continue;

      await repos.households.update(id, { ownerId: authenticatedUserId });
      await repos.members.update(owners[0].id, { userId: authenticatedUserId });
      const linked = { ...membership, userId: authenticatedUserId };
      // Preserve the membership ID/join date; seed does not record outbox rows.
      await repos.raw.memberships.seed([linked]);
      const revision = await repos.syncState.nextLocalRevision(id, 'memberships');
      await repos.syncState.storeLocalRecords(id, 'memberships', [
        createSyncRecordForEntity(id, 'memberships', linked.id, linked, revision),
      ]);
    }
    assertCurrentAccount();
  });
}
