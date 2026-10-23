/**
 * RemoteSyncAdapter — real HTTP collaboration against the frugal server.
 *
 * Local writes stay in the durable outbox (`sync_records`). This adapter:
 *   - ensures a server group exists for a local household,
 *   - pulls paginated, revisioned deltas and materialises them through RAW
 *     business repositories (so remote state never re-enters the outbox),
 *   - pushes bounded batches with a persisted operation id for idempotent
 *     retries, base versions for optimistic concurrency, and explicit
 *     conflicts instead of silent overwrites,
 *   - never treats a device-local identity as a cloud credential.
 */

import {
  ContributionEntry,
  ExpenseEntry,
  Household,
  Invitation,
  Member,
  Membership,
  PendingSyncMutation,
  PersistentTask,
  SyncChangeSignal,
  SyncCollection,
  SyncConflict,
  SyncGroupState,
  SyncRecord,
  TodoItem,
  Category,
  CrossLedgerSettlement,
} from '../../domain/entities';
import type { AllRepositories } from '../repositories/RepositoryFactory';
import type {
  RemoteInvitation,
  RemoteInvitationAcceptance,
  SyncGateway,
  SyncStatus,
} from '../../application/ports';

const WRITABLE: SyncCollection[] = [
  'contribution_entries',
  'expense_entries',
  'todo_items',
  'persistent_tasks',
  'categories',
  // Named members and group settings are ordinary group data: adding a member
  // or renaming one must reach the other devices, not only the creator's phone.
  'members',
  'households',
];
const BASELINE: SyncCollection[] = ['households', 'memberships', 'members'];
const PAGE_GUARD = 200;
const BATCH_LIMIT = 100;

export interface RemoteSyncConfig {
  baseUrl: string;
  /** Must return a real provider ID token; local identities are not accepted. */
  getAccessToken: () => Promise<string | null>;
  getRepos: () => AllRepositories;
  onRemoteChange?: (signal: SyncChangeSignal) => void;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
}

interface ServerChange {
  collection: SyncCollection;
  id: string;
  baseVersion?: number;
  value: Record<string, unknown> | null;
  version: number;
}

interface DeltaEvent {
  revision: number;
  changes: ServerChange[];
}

interface GroupRow {
  household: Household;
  revision: number;
  memberId: string;
  role: 'OWNER' | 'MEMBER';
}

class RemoteHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'RemoteHttpError';
  }
}

export class RemoteSyncAdapter implements SyncGateway {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly active = new Set<string>();
  private readonly runtimeErrors = new Map<string, string | null>();

  constructor(private readonly config: RemoteSyncConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  isAvailable(): boolean {
    return this.baseUrl.length > 0;
  }

  setOnRemoteChange(callback: (signal: SyncChangeSignal) => void): void {
    this.config.onRemoteChange = callback;
  }

  private repos(): AllRepositories {
    return this.config.getRepos();
  }

  private raw() {
    const repos = this.repos();
    return repos.raw ?? repos;
  }

  private async token(): Promise<string> {
    const token = await this.config.getAccessToken();
    if (!token) throw new Error('Connexion requise pour la synchronisation');
    return token;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (!response.ok) {
        const message =
          parsed && typeof parsed === 'object' && 'error' in parsed
            ? String((parsed as { error: unknown }).error)
            : `Erreur serveur (${response.status})`;
        throw new RemoteHttpError(response.status, message);
      }
      return parsed as T;
    } catch (error) {
      if (error instanceof RemoteHttpError) throw error;
      if ((error as { name?: string }).name === 'AbortError') {
        throw new Error('Délai de synchronisation dépassé');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async setError(householdId: string, message: string | null): Promise<void> {
    this.runtimeErrors.set(householdId, message);
    const state = await this.repos().syncState.getGroupState(householdId);
    if (!state) return;
    await this.repos().syncState.setGroupState({ ...state, lastError: message });
  }

  private async state(householdId: string): Promise<SyncGroupState> {
    const existing = await this.repos().syncState.getGroupState(householdId);
    return (
      existing ?? {
        householdId,
        remoteKnown: false,
        lastRevision: 0,
        lastSyncedAt: null,
        lastError: null,
      }
    );
  }

  async startSync(householdId: string): Promise<void> {
    if (!this.isAvailable() || this.timers.has(householdId)) return;
    // A previous session may have left durable outbox records (offline edit,
    // process killed during a push). Pull first so conflicts are detected
    // against the current authority, then drain the outbox immediately
    // instead of waiting for an unrelated local write.
    await this.pullChanges(householdId).catch((error) =>
      this.setError(householdId, this.message(error)),
    );
    await this.pushChanges(householdId).catch((error) =>
      this.setError(householdId, this.message(error)),
    );
    const interval = this.config.pollIntervalMs ?? 20_000;
    if (interval > 0) {
      const timer = setInterval(() => {
        void (async () => {
          try {
            await this.pushChanges(householdId);
            await this.pullChanges(householdId);
          } catch (error) {
            await this.setError(householdId, this.message(error));
          }
        })();
      }, interval);
      // Do not keep a Node/Jest process alive because of polling.
      (timer as unknown as { unref?: () => void }).unref?.();
      this.timers.set(householdId, timer);
    }
  }

  async stopSync(householdId: string): Promise<void> {
    const timer = this.timers.get(householdId);
    if (timer) clearInterval(timer);
    this.timers.delete(householdId);
  }

  async discoverGroups(userId: string): Promise<void> {
    if (!this.isAvailable()) return;
    const groups = await this.request<GroupRow[]>('GET', '/groups');
    const remoteIds = new Set(groups.map((group) => group.household.id));

    const localMemberships = await this.repos().memberships.getByUser(userId);
    for (const membership of localMemberships) {
      if (remoteIds.has(membership.householdId)) continue;
      const household = await this.repos().households.getById(membership.householdId);
      if (household && household.ownerId === userId) {
        await this.ensureRemoteGroup(household.id, userId).catch((error) =>
          this.setError(household.id, this.message(error)),
        );
      }
    }

    for (const group of groups) {
      const existing = await this.repos().syncState.getGroupState(group.household.id);
      if (!existing?.remoteKnown) {
        await this.repos().syncState.setGroupState({
          householdId: group.household.id,
          remoteKnown: true,
          lastRevision: existing?.lastRevision ?? 0,
          lastSyncedAt: existing?.lastSyncedAt ?? null,
          lastError: existing?.lastError ?? null,
        });
      }
      await this.pullChanges(group.household.id).catch((error) =>
        this.setError(group.household.id, this.message(error)),
      );
    }
  }

  async ensureRemoteGroup(householdId: string, userId: string): Promise<void> {
    const state = await this.state(householdId);
    if (state.remoteKnown) return;

    const household = await this.repos().households.getById(householdId);
    if (!household) throw new Error('Groupe local introuvable');
    if (household.ownerId !== userId) {
      throw new Error('Seul le propriétaire peut publier ce groupe');
    }
    const members = await this.repos().members.getByHousehold(householdId);
    const ownerMember = members.find((member) => member.userId === userId);
    if (!ownerMember) throw new Error('Membre propriétaire introuvable');
    const memberships = await this.repos().memberships.getByHousehold(householdId);
    const membership = memberships.find((entry) => entry.userId === userId);
    if (!membership) throw new Error('Adhésion propriétaire introuvable');

    const response = await this.request<{
      id?: string;
      revision?: number;
      changes?: ServerChange[];
    }>('POST', '/groups', {
      id: household.id,
      ownerMemberId: ownerMember.id,
      ownerName: ownerMember.name,
      name: household.name,
      unit: household.contributionUnit,
      membershipId: membership.id,
      members: members
        .filter((member) => member.id !== ownerMember.id && !member.userId)
        .map((member) => ({ id: member.id, name: member.name })),
    });

    const current = await this.state(householdId);
    await this.repos().syncState.setGroupState({
      ...current,
      remoteKnown: true,
      lastRevision: response.revision ?? 0,
      lastSyncedAt: new Date().toISOString(),
      lastError: null,
    });

    if (Array.isArray(response.changes)) {
      for (const change of response.changes) {
        await this.repos().syncState.setRemoteVersion(
          householdId,
          change.collection,
          change.id,
          change.version,
        );
      }
      // The baseline group rows were just created by the server; their local
      // copies are authoritative, so start their push cursors at the newest
      // local revision to avoid sending them again.
      for (const collection of BASELINE) {
        const records = await this.repos().syncState.getDirtyRecords(householdId, collection, 0);
        const max = records.reduce((value, record) => Math.max(value, record.revision), 0);
        if (max > 0) {
          await this.repos().syncState.setCursor({
            householdId,
            collection,
            lastRevision: max,
            lastSyncedAt: new Date().toISOString(),
          });
        }
      }
    } else {
      await this.pullChanges(householdId);
    }
  }

  async createInvitation(householdId: string, memberId: string): Promise<RemoteInvitation> {
    await this.token();
    const response = await this.request<{
      token: string;
      memberId: string;
      expiresAt: string;
    }>('POST', `/groups/${encodeURIComponent(householdId)}/invites`, { memberId });
    return { ...response, groupId: householdId };
  }

  async acceptInvitation(token: string): Promise<RemoteInvitationAcceptance> {
    await this.token();
    const response = await this.request<RemoteInvitationAcceptance>(
      'POST',
      `/invites/${encodeURIComponent(token)}/accept`,
      {},
    );
    const state = await this.repos().syncState.getGroupState(response.groupId);
    if (!state?.remoteKnown) {
      await this.repos().syncState.setGroupState({
        householdId: response.groupId,
        remoteKnown: true,
        lastRevision: state?.lastRevision ?? 0,
        lastSyncedAt: state?.lastSyncedAt ?? null,
        lastError: null,
      });
    }
    await this.pullChanges(response.groupId);
    return response;
  }

  async pullChanges(householdId: string): Promise<void> {
    if (!this.isAvailable() || this.active.has(householdId)) return;
    this.active.add(householdId);
    try {
      let state = await this.state(householdId);
      let cursor = state.lastRevision;
      for (let page = 0; page < PAGE_GUARD; page += 1) {
        const response = await this.request<{
          events: DeltaEvent[];
          hasMore: boolean;
        }>('GET', `/groups/${encodeURIComponent(householdId)}/deltas?since=${cursor}`);
        if (!response.events.length) break;
        let conflictDetected = false;
        for (const event of response.events) {
          conflictDetected = (await this.applyEvent(householdId, event)) || conflictDetected;
        }
        cursor = response.events[response.events.length - 1].revision;
        state = {
          ...state,
          lastRevision: cursor,
          lastSyncedAt: new Date().toISOString(),
          lastError: conflictDetected
            ? 'Conflit détecté : une modification locale a été conservée'
            : null,
        };
        await this.repos().syncState.setGroupState(state);
        if (!response.hasMore) break;
      }
      if (state.lastRevision !== cursor) {
        state = {
          ...state,
          lastRevision: cursor,
          lastSyncedAt: new Date().toISOString(),
        };
        await this.repos().syncState.setGroupState(state);
      }
      this.runtimeErrors.delete(householdId);
    } catch (error) {
      await this.setError(householdId, this.message(error));
      throw error;
    } finally {
      this.active.delete(householdId);
    }
  }

  private async applyEvent(householdId: string, event: DeltaEvent): Promise<boolean> {
    const repos = this.repos();
    const touched = new Set<SyncCollection>();
    let conflictDetected = false;

    const openConflicts = new Set(
      (await repos.syncState.getConflicts(householdId))
        .filter((conflict) => !conflict.resolvedAt)
        .map((conflict) => `${conflict.collection}:${conflict.entityId}`),
    );

    await repos.withTransaction(async () => {
      for (const change of event.changes) {
        const known = await repos.syncState.getRemoteVersion(
          householdId,
          change.collection,
          change.id,
        );
        if (change.version <= known) continue;
        const conflictKey = `${change.collection}:${change.id}`;
        // A resolved-by-user local edit may not have been pushed yet. While a
        // conflict is open we keep the local payload and only learn the new
        // server version, so a background pull can never silently erase it.
        if (openConflicts.has(conflictKey)) {
          await repos.syncState.setRemoteVersion(
            householdId,
            change.collection,
            change.id,
            change.version,
          );
          continue;
        }

        const pushed = await repos.syncState.getCursor(householdId, change.collection);
        const dirty = await repos.syncState.getDirtyRecords(
          householdId,
          change.collection,
          0,
        );
        const pending = dirty.find(
          (record) => record.id === change.id && record.revision > (pushed?.lastRevision ?? 0),
        );
        if (pending) {
          conflictDetected = true;
          await repos.syncState.recordConflict({
            id: this.conflictId(householdId, change),
            householdId,
            collection: change.collection,
            entityId: change.id,
            localRevision: pending.revision,
            remoteVersion: change.version,
            detectedAt: new Date().toISOString(),
            localPayload: pending.payload,
            remotePayload: change.value ? JSON.stringify(change.value) : null,
            resolvedAt: null,
          });
          openConflicts.add(conflictKey);
          continue;
        }

        await this.materialize(change);
        await repos.syncState.setRemoteVersion(
          householdId,
          change.collection,
          change.id,
          change.version,
        );
        touched.add(change.collection);
      }
      await repos.syncState.setGroupState({
        ...(await this.state(householdId)),
        lastRevision: event.revision,
      });
    });

    if (touched.size > 0 && this.config.onRemoteChange) {
      this.config.onRemoteChange({
        householdId,
        collections: Array.from(touched),
        receivedAt: new Date().toISOString(),
      });
    }
    return conflictDetected;
  }

  private conflictId(householdId: string, change: ServerChange): string {
    return `${householdId}:${change.collection}:${change.id}:${change.version}`;
  }

  private async materialize(change: ServerChange): Promise<void> {
    const repos = this.raw();
    const value = change.value;
    switch (change.collection) {
      case 'contribution_entries':
        if (!value) await repos.contributions.delete(change.id);
        else await repos.contributions.seed([value as unknown as ContributionEntry]);
        return;
      case 'expense_entries':
        if (!value) await repos.expenses.delete(change.id);
        else await repos.expenses.seed([value as unknown as ExpenseEntry]);
        return;
      case 'todo_items':
        if (!value) await repos.todos.delete(change.id);
        else await repos.todos.seed([value as unknown as TodoItem]);
        return;
      case 'persistent_tasks':
        if (!value) await repos.tasks.delete(change.id);
        else await repos.tasks.seed([value as unknown as PersistentTask]);
        return;
      case 'categories':
        if (!value) await repos.categories.delete(change.id);
        else await repos.categories.seed([value as unknown as Category]);
        return;
      case 'settlements':
        if (!value) await repos.settlements.delete(change.id);
        else await repos.settlements.seed([value as unknown as CrossLedgerSettlement]);
        return;
      case 'invitations':
        if (!value) await repos.invitations.delete(change.id);
        else await repos.invitations.seed([value as unknown as Invitation]);
        return;
      case 'households':
        if (!value) await repos.households.delete(change.id);
        else await repos.households.seed([value as unknown as Household]);
        return;
      case 'members':
        if (!value) return;
        await repos.members.seed([value as unknown as Member]);
        return;
      case 'memberships':
        if (!value) await repos.memberships.delete(change.id);
        else await repos.memberships.seed([value as unknown as Membership]);
        return;
      default:
        return;
    }
  }

  async pushChanges(householdId: string): Promise<void> {
    if (!this.isAvailable() || this.active.has(householdId)) return;
    this.active.add(householdId);
    try {
      await this.ensureRemoteGroup(
        householdId,
        (await this.repos().households.getById(householdId))?.ownerId ?? '',
      ).catch(() => undefined);
      const pending = await this.buildPending(householdId);
      if (!pending) {
        this.runtimeErrors.delete(householdId);
        return;
      }
      const result = await this.request<{ revision: number; changes: ServerChange[] }>(
        'POST',
        `/groups/${encodeURIComponent(householdId)}/mutations`,
        {
          operationId: pending.mutation.operationId,
          changes: JSON.parse(pending.mutation.changesJson),
        },
      );
      const repos = this.repos();
      await repos.withTransaction(async () => {
        for (const change of result.changes) {
          await repos.syncState.setRemoteVersion(
            householdId,
            change.collection,
            change.id,
            change.version,
          );
          // A successful push means the user's local payload is now the
          // authority for this entity; the open conflict is resolved.
          await repos.syncState.resolveConflicts(
            householdId,
            change.collection,
            change.id,
          );
        }
        const sent = JSON.parse(pending.mutation.sentJson) as Array<{
          collection: SyncCollection;
          revision: number;
        }>;
        const maxima = new Map<SyncCollection, number>();
        for (const record of sent) {
          maxima.set(record.collection, Math.max(maxima.get(record.collection) ?? 0, record.revision));
        }
        for (const [collection, revision] of maxima) {
          await repos.syncState.setCursor({
            householdId,
            collection,
            lastRevision: revision,
            lastSyncedAt: new Date().toISOString(),
          });
        }
        await repos.syncState.deletePendingMutation(householdId);
        const state = await this.state(householdId);
        await repos.syncState.setGroupState({
          ...state,
          lastSyncedAt: new Date().toISOString(),
          lastError: null,
        });
      });
      this.runtimeErrors.delete(householdId);
    } catch (error) {
      if (error instanceof RemoteHttpError && error.status === 409) {
        await this.recordPushConflicts(householdId);
      }
      await this.setError(householdId, this.message(error));
      throw error;
    } finally {
      this.active.delete(householdId);
    }
  }

  private async buildPending(
    householdId: string,
  ): Promise<{ mutation: PendingSyncMutation } | null> {
    const repos = this.repos();
    const existing = await repos.syncState.getPendingMutation(householdId);
    if (existing) return { mutation: existing };

    const changes: Array<{
      collection: SyncCollection;
      id: string;
      baseVersion: number;
      value: Record<string, unknown> | null;
    }> = [];
    const sent: Array<{ collection: SyncCollection; id: string; revision: number }> = [];
    const conflicts: SyncConflict[] = [];

    for (const collection of WRITABLE) {
      const cursor = await repos.syncState.getCursor(householdId, collection);
      const records = await repos.syncState.getDirtyRecords(
        householdId,
        collection,
        cursor?.lastRevision ?? 0,
      );
      for (const record of records) {
        if (changes.length >= BATCH_LIMIT) break;
        const value = record.deletedAt
          ? null
          : (JSON.parse(record.payload ?? 'null') as Record<string, unknown> | null);
        if (value && Array.isArray(value.attachments) && value.attachments.length > 0) {
          conflicts.push({
            id: this.conflictId(householdId, {
              collection,
              id: record.id,
              value,
              version: 0,
            }),
            householdId,
            collection,
            entityId: record.id,
            localRevision: record.revision,
            remoteVersion: 0,
            detectedAt: new Date().toISOString(),
            localPayload: record.payload,
            remotePayload: null,
            resolvedAt: null,
          });
          sent.push({ collection, id: record.id, revision: record.revision });
          continue;
        }
        const baseVersion = await repos.syncState.getRemoteVersion(
          householdId,
          collection,
          record.id,
        );
        changes.push({ collection, id: record.id, baseVersion, value });
        sent.push({ collection, id: record.id, revision: record.revision });
      }
    }

    for (const conflict of conflicts) await repos.syncState.recordConflict(conflict);
    if (!changes.length) {
      if (sent.length > 0) {
        const maxima = new Map<SyncCollection, number>();
        for (const record of sent) {
          maxima.set(record.collection, Math.max(maxima.get(record.collection) ?? 0, record.revision));
        }
        for (const [collection, revision] of maxima) {
          await repos.syncState.setCursor({
            householdId,
            collection,
            lastRevision: revision,
            lastSyncedAt: new Date().toISOString(),
          });
        }
      }
      return null;
    }

    const mutation: PendingSyncMutation = {
      householdId,
      operationId: this.operationId(),
      changesJson: JSON.stringify(changes),
      sentJson: JSON.stringify(sent),
      createdAt: new Date().toISOString(),
    };
    await repos.syncState.savePendingMutation(mutation);
    return { mutation };
  }

  private async recordPushConflicts(householdId: string): Promise<void> {
    const repos = this.repos();
    const pending = await repos.syncState.getPendingMutation(householdId);
    if (!pending) return;
    const changes = JSON.parse(pending.changesJson) as Array<{
      collection: SyncCollection;
      id: string;
      value: Record<string, unknown> | null;
    }>;
    const sent = JSON.parse(pending.sentJson) as Array<{
      collection: SyncCollection;
      id: string;
      revision: number;
    }>;
    const maxima = new Map<SyncCollection, number>();
    await repos.withTransaction(async () => {
      for (const change of changes) {
        await repos.syncState.recordConflict({
          id: `${householdId}:${change.collection}:${change.id}:push`,
          householdId,
          collection: change.collection,
          entityId: change.id,
          localRevision: sent.find(
            (record) => record.collection === change.collection && record.id === change.id,
          )?.revision ?? 0,
          remoteVersion: await repos.syncState.getRemoteVersion(
            householdId,
            change.collection,
            change.id,
          ),
          detectedAt: new Date().toISOString(),
          localPayload: change.value ? JSON.stringify(change.value) : null,
          remotePayload: null,
          resolvedAt: null,
        });
      }
      for (const record of sent) {
        maxima.set(record.collection, Math.max(maxima.get(record.collection) ?? 0, record.revision));
      }
      for (const [collection, revision] of maxima) {
        await repos.syncState.setCursor({
          householdId,
          collection,
          lastRevision: revision,
          lastSyncedAt: new Date().toISOString(),
        });
      }
      await repos.syncState.deletePendingMutation(householdId);
    });
  }

  async getStatus(householdId: string): Promise<SyncStatus> {
    const repos = this.repos();
    const state = await repos.syncState.getGroupState(householdId);
    let pendingChanges = 0;
    for (const collection of WRITABLE) {
      const cursor = await repos.syncState.getCursor(householdId, collection);
      const records = await repos.syncState.getDirtyRecords(
        householdId,
        collection,
        cursor?.lastRevision ?? 0,
      );
      pendingChanges += records.length;
    }
    const pendingMutation = await repos.syncState.getPendingMutation(householdId);
    const conflicts = await repos.syncState.getConflicts(householdId);
    return {
      isSyncing: this.active.has(householdId),
      lastSyncedAt: state?.lastSyncedAt ?? null,
      pendingChanges: pendingChanges + (pendingMutation ? 1 : 0),
      error:
        this.runtimeErrors.get(householdId) ??
        state?.lastError ??
        (conflicts.some((conflict) => !conflict.resolvedAt)
          ? 'Conflit de synchronisation à vérifier'
          : null),
      conflicts: conflicts.filter((conflict) => !conflict.resolvedAt).length,
    };
  }

  private operationId(): string {
    const random = Array.from({ length: 16 }, () =>
      'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)],
    ).join('');
    return `op-${Date.now().toString(36)}-${random}`;
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : 'Synchronisation indisponible';
  }
}
