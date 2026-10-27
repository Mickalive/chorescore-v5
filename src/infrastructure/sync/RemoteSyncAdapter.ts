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
  Attachment,
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
  MediaGateway,
  RemoteInvitation,
  RemoteInvitationAcceptance,
  SyncGateway,
  SyncStatus,
} from '../../application/ports';

const WRITABLE: SyncCollection[] = [
  // Named members and group settings are ordinary group data: adding a member,
  // renaming one or enabling compensation must reach the other devices before
  // dependent records are validated by the authority.
  'members',
  'households',
  'categories',
  'contribution_entries',
  'expense_entries',
  'todo_items',
  'persistent_tasks',
  // Compensation is validated against the now-current rate and both ledgers,
  // so it is always pushed after the records it depends on.
  'settlements',
];
const BASELINE: SyncCollection[] = ['households', 'memberships', 'members'];
const PAGE_GUARD = 200;
const BATCH_LIMIT = 100;

export type RemoteRequest = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<unknown>;

export interface RemoteSyncConfig {
  /** Empty when a custom `request` authority (e.g. Firestore) is supplied. */
  baseUrl?: string;
  /** Optional non-HTTP authority implementing the same bounded contract. */
  request?: RemoteRequest;
  /** Must return a real provider ID token; local identities are not accepted. */
  getAccessToken: () => Promise<string | null>;
  getRepos: () => AllRepositories;
  onRemoteChange?: (signal: SyncChangeSignal) => void;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  /** Private cloud media transport; required to sync entries with photos. */
  media?: MediaGateway;
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

interface SyncSession {
  cancelled: boolean;
  ready: Promise<void>;
  timer?: ReturnType<typeof setInterval>;
}

export class RemoteSyncAdapter implements SyncGateway {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sessions = new Map<string, SyncSession>();
  private readonly active = new Set<string>();
  private readonly runtimeErrors = new Map<string, string | null>();

  constructor(private readonly config: RemoteSyncConfig) {
    this.baseUrl = (config.baseUrl ?? '').replace(/\/+$/, '');
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  isAvailable(): boolean {
    return Boolean(this.config.request) || this.baseUrl.length > 0;
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
    if (this.config.request) {
      return (await this.config.request(method, path, body)) as T;
    }
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
    if (!this.isAvailable()) return;
    const existing = this.sessions.get(householdId);
    if (existing) return existing.ready;
    const session: SyncSession = { cancelled: false, ready: Promise.resolve() };
    this.sessions.set(householdId, session);
    // A previous session may have left durable outbox records (offline edit,
    // process killed during a push). Pull first so conflicts are detected
    // against the current authority, then drain the outbox immediately
    // instead of waiting for an unrelated local write.
    session.ready = (async () => {
      const recordError = (error: unknown) => session.cancelled
        ? undefined : this.setError(householdId, this.message(error));
      await this.pullChanges(householdId).catch(recordError);
      if (session.cancelled) return;
      await this.pushChanges(householdId).catch(recordError);
      if (session.cancelled) return;
      const interval = this.config.pollIntervalMs ?? 20_000;
      if (interval > 0) {
        session.timer = setInterval(() => {
          if (session.cancelled) return;
          void (async () => {
            try {
              await this.pushChanges(householdId);
              if (!session.cancelled) await this.pullChanges(householdId);
            } catch (error) {
              if (!session.cancelled) await this.setError(householdId, this.message(error));
            }
          })();
        }, interval);
        // Do not keep a Node/Jest process alive because of polling.
        (session.timer as unknown as { unref?: () => void }).unref?.();
      }
    })().finally(() => {
      if (session.timer === undefined && this.sessions.get(householdId) === session) {
        this.sessions.delete(householdId);
      }
    });
    return session.ready;
  }

  async stopSync(householdId: string): Promise<void> {
    const ids = householdId === '*' ? [...this.sessions.keys()] : [householdId];
    for (const id of ids) {
      const session = this.sessions.get(id);
      if (!session) continue;
      session.cancelled = true;
      if (session.timer !== undefined) clearInterval(session.timer);
      this.sessions.delete(id);
    }
  }

  async deleteGroup(householdId: string): Promise<void> {
    if (!this.isAvailable()) throw new Error('Synchronisation indisponible');
    await this.request('POST', `/groups/${encodeURIComponent(householdId)}/delete`, {});
    await this.pullChanges(householdId);
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
    const repos = this.repos();
    const household = await repos.households.getById(householdId);
    if (!household) throw new Error('Groupe local introuvable');
    if (household.ownerId !== userId) throw new Error('Seul le propriétaire peut publier ce groupe');
    const members = await repos.members.getByHousehold(householdId);
    const ownerMember = members.find(member => member.userId === userId);
    if (!ownerMember) throw new Error('Membre propriétaire introuvable');
    const memberships = await repos.memberships.getByHousehold(householdId);
    const membership = memberships.find(entry => entry.userId === userId);
    if (!membership) throw new Error('Adhésion propriétaire introuvable');

    // Capture revisions BEFORE the request. A local edit while the response is
    // pending must remain dirty, even if it rewrites a baseline record.
    const baseline = new Map<SyncCollection, SyncRecord[]>();
    for (const collection of BASELINE) {
      const cursor = await repos.syncState.getCursor(householdId, collection);
      baseline.set(collection, await repos.syncState.getDirtyRecords(householdId, collection, cursor?.lastRevision ?? 0));
    }
    let response = await this.request<{ id?: string; revision?: number; changes?: ServerChange[] }>('POST', '/groups', {
      id: household.id, ownerMemberId: ownerMember.id, ownerName: ownerMember.name,
      name: household.name, unit: household.contributionUnit, membershipId: membership.id,
      members: members.filter(member => member.id !== ownerMember.id && !member.userId)
        .map(member => ({ id: member.id, name: member.name })),
    });
    if (!Array.isArray(response.changes)) {
      // The authority may have committed creation before its response was
      // lost. Recover its ORIGINAL baseline, never the current revision (that
      // would skip subsequent invitations/writes). Do not recurse into the
      // public pull method, which may already be locked by the current push.
      const recovered = await this.request<{ events: DeltaEvent[] }>('GET', `/groups/${encodeURIComponent(householdId)}/deltas?since=0`);
      const first = recovered.events[0];
      if (!first || first.revision !== 1) throw new Error('Base du groupe partagé introuvable');
      this.validateDelta(householdId, first, 0);
      response = { ...response, revision: first.revision, changes: first.changes };
    }
    const changes = response.changes!;
    await repos.withTransaction(async () => {
      for (const change of changes) {
        const previous = await repos.syncState.getRemoteVersion(householdId, change.collection, change.id);
        await repos.syncState.setRemoteVersion(householdId, change.collection, change.id, Math.max(previous, change.version));
      }
      for (const collection of BASELINE) {
        let max = (await repos.syncState.getCursor(householdId, collection))?.lastRevision ?? 0;
        for (const record of baseline.get(collection) ?? []) {
          const remote = changes.find(change => change.collection === collection && change.id === record.id);
          // Do not acknowledge offline settings, renamed members or members
          // added after the original creation. Stop at the first unsent row so
          // a collection cursor can never jump over a local change.
          if (!remote || !this.sameBaselineRecord(collection, record, remote.value)
              || await repos.syncState.getRemoteVersion(householdId, collection, record.id) !== remote.version) break;
          max = Math.max(max, record.revision);
          await repos.syncState.resolveConflicts(householdId, collection, record.id);
        }
        if (max > 0) await repos.syncState.setCursor({ householdId, collection, lastRevision: max, lastSyncedAt: new Date().toISOString() });
      }
      const current = await this.state(householdId);
      await repos.syncState.setGroupState({ ...current, remoteKnown: true,
        lastRevision: Math.max(current.lastRevision, response.revision ?? 0),
        lastSyncedAt: new Date().toISOString(), lastError: null });
    });
  }

  private sameBaselineRecord(collection: SyncCollection, record: SyncRecord, remote: Record<string, unknown> | null): boolean {
    if (record.deletedAt || !record.payload || !remote) return false;
    const local = JSON.parse(record.payload) as Record<string, unknown>;
    const fields = collection === 'households'
      ? ['id', 'name', 'ownerId', 'contributionUnit', 'crossLedgerCompensationEnabled', 'contributionToMoneyRate']
      : collection === 'members' ? ['id', 'householdId', 'name', 'userId'] : ['id', 'householdId', 'userId', 'role'];
    return fields.every(field => JSON.stringify(local[field] ?? null) === JSON.stringify(remote[field] ?? null));
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

  async revokeInvitation(householdId: string, token: string): Promise<void> {
    await this.token();
    await this.request<{ revoked: boolean }>(
      'POST',
      `/groups/${encodeURIComponent(householdId)}/invites/${encodeURIComponent(token)}/revoke`,
      {},
    );
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

  /**
   * Send an atomic completion to the authority. The pending local outbox is
   * drained first so the server sees the todo and its references. The returned
   * ledger/todo rows are materialised through the raw repositories; a retry or
   * a concurrent completion cannot create a second entry because the server
   * owns the deterministic ledger id.
   */
  async completeTodo(
    householdId: string,
    todoId: string,
    input: Record<string, unknown>,
  ): Promise<void> {
    if (!this.isAvailable()) throw new Error('Synchronisation indisponible');
    await this.ensureRemoteGroup(
      householdId,
      (await this.repos().households.getById(householdId))?.ownerId ?? '',
    ).catch(() => undefined);
    await this.pushChanges(householdId);
    const result = await this.request<{ revision: number; changes: ServerChange[] }>(
      'POST',
      `/groups/${encodeURIComponent(householdId)}/todos/${encodeURIComponent(todoId)}/complete`,
      input,
    );
    const repos = this.repos();
    await repos.withTransaction(async () => {
      for (const change of result.changes) {
        await this.materialize(change);
        await repos.syncState.setRemoteVersion(
          householdId,
          change.collection,
          change.id,
          change.version,
        );
        await repos.syncState.resolveConflicts(householdId, change.collection, change.id);
      }
      const state = await this.state(householdId);
      await repos.syncState.setGroupState({
        ...state,
        lastSyncedAt: new Date().toISOString(),
        lastError: null,
      });
    });
    // Learn the authoritative event and any changes made by other devices
    // since the last pull without skipping revisions.
    await this.pullChanges(householdId).catch((error) =>
      this.setError(householdId, this.message(error)),
    );
    if (this.config.onRemoteChange) {
      this.config.onRemoteChange({
        householdId,
        collections: result.changes.map((change) => change.collection),
        receivedAt: new Date().toISOString(),
      });
    }
    this.runtimeErrors.delete(householdId);
  }

  async getConflicts(householdId: string) {
    const conflicts = await this.repos().syncState.getConflicts(householdId);
    return conflicts
      .filter((conflict) => !conflict.resolvedAt)
      .map((conflict) => ({
        id: conflict.id,
        collection: conflict.collection,
        entityId: conflict.entityId,
        detectedAt: conflict.detectedAt,
        localPayload: conflict.localPayload,
        remotePayload: conflict.remotePayload,
      }));
  }

  /**
   * Resolve one conflict explicitly. "local" requeues the retained local
   * payload at the newest authority version and pushes it; "remote" discards
   * the local outbox row and materialises the authority payload. Neither path
   * silently overwrites data without the user's choice.
   */
  async resolveConflict(
    householdId: string,
    conflictId: string,
    choice: 'local' | 'remote',
  ): Promise<void> {
    const repos = this.repos();
    // Learn the newest authority version/payload first. Open conflicts are
    // preserved during this pull, so it can never erase the user's local edit.
    await this.pullChanges(householdId);
    const conflict = (await repos.syncState.getConflicts(householdId))
      .find((entry) => entry.id === conflictId && !entry.resolvedAt);
    if (!conflict) throw new Error('Conflit introuvable');
    await repos.withTransaction(async () => {
      await repos.syncState.deletePendingMutation(householdId);
      if (choice === 'local') {
        const revision = await repos.syncState.nextLocalRevision(
          householdId,
          conflict.collection,
        );
        await repos.syncState.storeLocalRecords(householdId, conflict.collection, [{
          id: conflict.entityId,
          householdId,
          collection: conflict.collection,
          revision,
          updatedAt: new Date().toISOString(),
          deletedAt: conflict.localPayload === null ? new Date().toISOString() : null,
          payload: conflict.localPayload,
        }]);
        await repos.syncState.setRemoteVersion(
          householdId,
          conflict.collection,
          conflict.entityId,
          conflict.remoteVersion,
        );
      } else {
        const value = conflict.remotePayload
          ? (JSON.parse(conflict.remotePayload) as Record<string, unknown>)
          : null;
        await this.materialize({
          collection: conflict.collection,
          id: conflict.entityId,
          value,
          version: conflict.remoteVersion,
        });
        await repos.syncState.discardLocalRecord(
          householdId,
          conflict.collection,
          conflict.entityId,
        );
        await repos.syncState.setRemoteVersion(
          householdId,
          conflict.collection,
          conflict.entityId,
          conflict.remoteVersion,
        );
      }
      await repos.syncState.resolveConflicts(
        householdId,
        conflict.collection,
        conflict.entityId,
      );
    });
    if (choice === 'local') {
      await this.pushChanges(householdId);
      await this.pullChanges(householdId).catch(() => undefined);
    } else if (this.config.onRemoteChange) {
      this.config.onRemoteChange({
        householdId,
        collections: [conflict.collection],
        receivedAt: new Date().toISOString(),
      });
    }
  }

  async pullChanges(householdId: string): Promise<void> {
    if (!this.isAvailable() || this.active.has(householdId)) return;
    if (!(await this.state(householdId)).remoteKnown) {
      const household = await this.repos().households.getById(householdId);
      if (household) await this.ensureRemoteGroup(householdId, household.ownerId);
    }
    if (this.active.has(householdId)) return;
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
          conflictDetected = (await this.applyEvent(householdId, event, cursor)) || conflictDetected;
          cursor = event.revision;
        }
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

  private validateDelta(householdId: string, event: DeltaEvent, cursor: number): void {
    if (!event || typeof event !== 'object') throw new Error('Delta distant invalide');
    const revision = Number(event.revision);
    if (!Number.isSafeInteger(revision) || revision <= cursor) {
      throw new Error('Révision de delta incohérente');
    }
    if (!Array.isArray(event.changes) || event.changes.length === 0 || event.changes.length > BATCH_LIMIT) {
      throw new Error('Lot de delta invalide');
    }
    const allowed = new Set<string>([
      ...WRITABLE,
      'memberships',
      'invitations',
    ]);
    const seen = new Set<string>();
    for (const raw of event.changes as unknown[]) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Changement distant invalide');
      }
      const change = raw as Partial<ServerChange>;
      if (typeof change.collection !== 'string' || !allowed.has(change.collection)) {
        throw new Error('Collection distante refusée');
      }
      if (typeof change.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(change.id)) {
        throw new Error('Identifiant distant invalide');
      }
      if (!Number.isSafeInteger(change.version) || Number(change.version) < 1) {
        throw new Error('Version distante invalide');
      }
      const key = `${change.collection}:${change.id}`;
      if (seen.has(key)) throw new Error('Changement distant dupliqué');
      seen.add(key);
      const value = change.value;
      if (value === null) {
        if (change.collection === 'households' && change.id !== householdId) {
          throw new Error('Suppression de foyer hors tenant refusée');
        }
        continue;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Valeur distante invalide');
      }
      const payload = value as Record<string, unknown>;
      if (payload.id !== change.id) throw new Error('Identifiant de charge utile incohérent');
      if (change.collection === 'households') {
        if (change.id !== householdId || payload.id !== householdId) {
          throw new Error('Foyer distant hors tenant refusé');
        }
        if (typeof payload.ownerId !== 'string' || payload.ownerId.length === 0) {
          throw new Error('Propriétaire de foyer distant invalide');
        }
      } else if (payload.householdId !== householdId) {
        throw new Error('Charge utile distante hors tenant refusée');
      }
    }
  }

  private async applyEvent(householdId: string, event: DeltaEvent, cursor: number): Promise<boolean> {
    this.validateDelta(householdId, event, cursor);
    const repos = this.repos();
    const touched = new Set<SyncCollection>();
    let conflictDetected = false;
    let groupDeleted = false;

    const openConflicts = new Map<string, SyncConflict>();
    for (const conflict of await repos.syncState.getConflicts(householdId)) {
      if (!conflict.resolvedAt) {
        openConflicts.set(`${conflict.collection}:${conflict.entityId}`, conflict);
      }
    }

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
        // The newest authority payload is retained so the user can inspect and
        // deliberately choose it instead of accepting a blind overwrite.
        const open = openConflicts.get(conflictKey);
        if (open) {
          const remotePayload = change.value ? JSON.stringify(change.value) : null;
          const updated = {
            ...open,
            remoteVersion: change.version,
            remotePayload,
          };
          await repos.syncState.recordConflict(updated);
          openConflicts.set(conflictKey, updated);
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
          const conflict: SyncConflict = {
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
          };
          await repos.syncState.recordConflict(conflict);
          openConflicts.set(conflictKey, conflict);
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
        if (change.collection === 'households' && change.value === null) groupDeleted = true;
      }
      await repos.syncState.setGroupState({
        ...(await this.state(householdId)),
        lastRevision: event.revision,
      });
    });

    if (groupDeleted) await this.stopSync(householdId);
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
      if ((error as { status?: number }).status === 409) {
        await this.recordPushConflicts(householdId);
      }
      await this.setError(householdId, this.message(error));
      throw error;
    } finally {
      this.active.delete(householdId);
    }
  }

  /**
   * Uploads any private photo that has not reached the authority yet. The
   * originating device keeps its local URI; other devices receive the same
   * record with `remoteRef` and resolve it through the media cache.
   */
  private async uploadAttachments(
    householdId: string,
    value: Record<string, unknown>,
    media: MediaGateway,
  ): Promise<Record<string, unknown>> {
    const attachments = value.attachments as Attachment[];
    const uploaded: Attachment[] = [];
    for (const attachment of attachments) {
      if (attachment.kind !== 'photo') throw new Error('Unsupported attachment kind');
      if (attachment.remoteRef) {
        uploaded.push(attachment);
        continue;
      }
      const result = await media.upload(householdId, attachment);
      uploaded.push({ ...attachment, remoteRef: result.remoteRef, byteSize: result.byteSize });
    }
    return { ...value, attachments: uploaded };
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
      if (changes.length >= BATCH_LIMIT) break;
      const cursor = await repos.syncState.getCursor(householdId, collection);
      const records = await repos.syncState.getDirtyRecords(
        householdId,
        collection,
        cursor?.lastRevision ?? 0,
        BATCH_LIMIT - changes.length,
      );
      for (const record of records) {
        if (changes.length >= BATCH_LIMIT) break;
        let value = record.deletedAt
          ? null
          : (JSON.parse(record.payload ?? 'null') as Record<string, unknown> | null);
        if (value && Array.isArray(value.attachments) && value.attachments.length > 0) {
          const media = this.config.media;
          if (!media?.isAvailable()) {
            // Honest limitation: a build without private media storage keeps
            // the local photo and surfaces a explicit unresolved conflict
            // instead of pretending the photo reached the other device.
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
          value = await this.uploadAttachments(householdId, value, media);
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
      pendingChanges += await repos.syncState.countDirtyRecords(
        householdId,
        collection,
        cursor?.lastRevision ?? 0,
      );
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
