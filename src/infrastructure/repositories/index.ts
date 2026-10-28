/**
 * ChoreScore V3 — Repository Interfaces
 *
 * Provider-independent contracts for data access.
 * V3 domain entities carry their own unit/currency so history is never reinterpreted.
 */

import {
  ContributionUnit,
  User,
  Membership,
  Household,
  Member,
  ContributionEntry,
  PersistentTask,
  TodoItem,
  ExpenseEntry,
  CrossLedgerSettlement,
  Invitation,
  Category,
  SyncCursor,
  SyncRecord,
  SyncCollection,
  SyncGroupState,
  SyncConflict,
  PendingSyncMutation,
} from '../../domain/entities';
import type { BalanceSnapshot } from '../../domain/calculations/materializedBalances';

export interface BalanceProjectionRepository {
  /** Caller uses its repository transaction when combining this with writes.
   * SQLite reads stored member totals; legacy rows are backfilled in bounded
   * batches once. Later reads transfer only member totals, never the history.
   */
  getByHousehold(householdId: string, unit: ContributionUnit, memberIds: string[]): Promise<BalanceSnapshot>;
}

/**
 * Idempotent upsert of full entities with known ids.
 *
 * Used by the demo fixture (canonical ids), tests and future sync
 * reconciliation. Implementations must not duplicate rows when the same
 * id (or unique key) is seeded again.
 */
export interface SeedableRepository<T> {
  seed(items: T[]): Promise<void> | void;
}

export interface UserRepository extends SeedableRepository<User> {
  getById(id: string): Promise<User | null>;
  getByEmail(email: string): Promise<User | null>;
  create(data: Omit<User, 'id' | 'createdAt'>): Promise<User>;
  update(id: string, data: Partial<User>): Promise<User>;
  getAll(): Promise<User[]>;
}

export interface MembershipRepository extends SeedableRepository<Membership> {
  getByUser(userId: string): Promise<Membership[]>;
  getByHousehold(householdId: string): Promise<Membership[]>;
  getByUserAndHousehold(userId: string, householdId: string): Promise<Membership | null>;
  create(data: Omit<Membership, 'id' | 'joinedAt'>): Promise<Membership>;
  delete(id: string): Promise<void>;
}

export interface HouseholdRepository extends SeedableRepository<Household> {
  getAll(): Promise<Household[]>;
  getById(id: string): Promise<Household | null>;
  create(data: Omit<Household, 'id' | 'createdAt'>): Promise<Household>;
  update(id: string, data: Partial<Household>): Promise<Household>;
  delete(id: string): Promise<void>;
}

export interface MemberRepository extends SeedableRepository<Member> {
  getByHousehold(householdId: string): Promise<Member[]>;
  getByHouseholdPaginated(householdId: string, query?: PaginatedQuery): Promise<PaginatedResult<Member>>;
  getById(id: string): Promise<Member | null>;
  create(data: Omit<Member, 'id' | 'joinedAt'>): Promise<Member>;
  /**
   * V4-09: update an existing member. Used to link a named member to an
   * account when a targeted invitation is accepted (userId becomes the
   * accepting account id) without rewriting the member's identity or history.
   */
  update(id: string, data: Partial<Member>): Promise<Member>;
}

// ── V4-01: Category Repository ─────────────────────────────────

/**
 * Only `name` and `defaultTaskRatio` are editable: identity (`id`), tenancy
 * (`householdId`) and provenance (`createdAt`) are immutable, so every
 * adapter behaves identically and a category can never be moved between
 * groups behind the ledger's back.
 */
export type CategoryUpdate = Partial<Pick<Category, 'name' | 'defaultTaskRatio'>>;

/**
 * User-created categories. No product path ever seeds a taxonomy: a
 * household starts with zero categories and only stores what its members
 * typed. (The `seed` member exists purely as test/fixture plumbing, the same
 * as every other repository — nothing in the app calls it.) Deleting a
 * category never touches ledger entries (they keep their categoryId +
 * creation-time label snapshot).
 */
export interface CategoryRepository extends SeedableRepository<Category> {
  getByHousehold(householdId: string): Promise<Category[]>;
  getByHouseholdPaginated(householdId: string, query?: PaginatedQuery): Promise<PaginatedResult<Category>>;
  getById(id: string): Promise<Category | null>;
  create(data: Omit<Category, 'id' | 'createdAt' | 'updatedAt'>): Promise<Category>;
  update(id: string, data: CategoryUpdate): Promise<Category>;
  delete(id: string): Promise<void>;
}

export interface PaginatedResult<T> {
  items: T[];
  /**
   * Opaque composite cursor encoding `{ o: occurredAt, i: id }` for stable
   * tie-breaking when multiple entries share the same occurredAt.  Null when
   * no more pages exist.
   */
  cursor: string | null;
  hasMore: boolean;
}

export interface PaginatedQuery {
  limit?: number;
  /** Exclusive composite cursor — items strictly older than the encoded position. */
  cursor?: string | null;
  /** Only include entries at or after this timestamp (inclusive). */
  after?: string;
}

export interface ContributionEntryRepository extends SeedableRepository<ContributionEntry> {
  getByHousehold(householdId: string): Promise<ContributionEntry[]>;
  getByHouseholdPaginated(householdId: string, query?: PaginatedQuery): Promise<PaginatedResult<ContributionEntry>>;
  getById(id: string): Promise<ContributionEntry | null>;
  create(entry: Omit<ContributionEntry, 'id'>): Promise<ContributionEntry>;
  update(id: string, data: Partial<ContributionEntry>): Promise<ContributionEntry>;
  delete(id: string): Promise<void>;
}

export interface PersistentTaskRepository extends SeedableRepository<PersistentTask> {
  getByHousehold(householdId: string): Promise<PersistentTask[]>;
  getByHouseholdPaginated(householdId: string, query?: PaginatedQuery): Promise<PaginatedResult<PersistentTask>>;
  getById(id: string): Promise<PersistentTask | null>;
  create(task: Omit<PersistentTask, 'id' | 'createdAt'>): Promise<PersistentTask>;
  delete(id: string): Promise<void>;
}

export interface TodoRepository extends SeedableRepository<TodoItem> {
  getOpenByHousehold(householdId: string): Promise<TodoItem[]>;
  getFutureReminders(householdId: string, after: string): Promise<TodoItem[]>;
  getByHousehold(householdId: string): Promise<TodoItem[]>;
  getByHouseholdPaginated(householdId: string, query?: PaginatedQuery): Promise<PaginatedResult<TodoItem>>;
  getById(id: string): Promise<TodoItem | null>;
  create(todo: Omit<TodoItem, 'id' | 'createdAt'>): Promise<TodoItem>;
  update(id: string, data: Partial<TodoItem>): Promise<TodoItem>;
  delete(id: string): Promise<void>;
}

export interface ExpenseEntryRepository extends SeedableRepository<ExpenseEntry> {
  getByHousehold(householdId: string): Promise<ExpenseEntry[]>;
  getByHouseholdPaginated(householdId: string, query?: PaginatedQuery): Promise<PaginatedResult<ExpenseEntry>>;
  getById(id: string): Promise<ExpenseEntry | null>;
  create(entry: Omit<ExpenseEntry, 'id'>): Promise<ExpenseEntry>;
  update(id: string, data: Partial<ExpenseEntry>): Promise<ExpenseEntry>;
  delete(id: string): Promise<void>;
}

export interface SettlementRepository extends SeedableRepository<CrossLedgerSettlement> {
  getByHousehold(householdId: string): Promise<CrossLedgerSettlement[]>;
  getByHouseholdPaginated(householdId: string, query?: PaginatedQuery): Promise<PaginatedResult<CrossLedgerSettlement>>;
  getById(id: string): Promise<CrossLedgerSettlement | null>;
  create(settlement: Omit<CrossLedgerSettlement, 'id'>): Promise<CrossLedgerSettlement>;
  delete(id: string): Promise<void>;
}

// ── V3-06: Invitation Repository ───────────────────────────────

export interface InvitationRepository extends SeedableRepository<Invitation> {
  getById(id: string): Promise<Invitation | null>;
  getByLinkToken(token: string): Promise<Invitation | null>;
  getByHousehold(householdId: string): Promise<Invitation[]>;
  getByHouseholdPaginated(householdId: string, query?: PaginatedQuery): Promise<PaginatedResult<Invitation>>;
  getPendingByEmail(email: string): Promise<Invitation[]>;
  create(data: Omit<Invitation, 'id' | 'createdAt'>): Promise<Invitation>;
  updateStatus(id: string, status: Invitation['status']): Promise<Invitation>;
  delete(id: string): Promise<void>;
}

// ── V3-06: Sync State Repository ───────────────────────────────

export interface SyncStateRepository {
  /** Reserve a monotonically increasing, persisted local outbox sequence. */
  nextLocalRevision(householdId: string, collection: SyncCollection): Promise<number>;
  getCursor(householdId: string, collection: SyncCollection): Promise<SyncCursor | null>;
  setCursor(cursor: SyncCursor): Promise<void>;
  /**
   * Store remote delta records, materialize into business tables, and
   * optionally advance the pull cursor — all inside a single transaction.
   *
   * @param pullCursorToAdvance - When provided, the cursor is advanced
   *   atomically together with materialization so that a mid-transaction
   *   failure rolls back BOTH the business writes AND the cursor, ensuring
   *   the delta is re-fetched on the next pull.
   */
  applyDeltas(
    householdId: string,
    collection: SyncCollection,
    records: SyncRecord[],
    pullCursorToAdvance?: SyncCursor,
  ): Promise<SyncRecord[]>;
  /** Store local dirty records WITHOUT advancing the cursor (push path). */
  storeLocalRecords(householdId: string, collection: SyncCollection, records: SyncRecord[]): Promise<void>;
  /** Read pending records in revision order; limit bounds push-batch memory. */
  countDirtyRecords(householdId: string, collection: SyncCollection, sinceRevision: number): Promise<number>;
  getDirtyRecords(householdId: string, collection: SyncCollection, sinceRevision: number, limit?: number): Promise<SyncRecord[]>;

  // ── Remote collaboration metadata (server revisions are distinct from
  // local outbox revisions; never reuse one for the other). ──────────────
  getGroupState(householdId: string): Promise<SyncGroupState | null>;
  setGroupState(state: SyncGroupState): Promise<void>;
  getRemoteVersion(householdId: string, collection: SyncCollection, entityId: string): Promise<number>;
  setRemoteVersion(
    householdId: string,
    collection: SyncCollection,
    entityId: string,
    version: number,
  ): Promise<void>;
  getPendingMutation(householdId: string): Promise<PendingSyncMutation | null>;
  savePendingMutation(mutation: PendingSyncMutation): Promise<void>;
  deletePendingMutation(householdId: string): Promise<void>;
  recordConflict(conflict: SyncConflict): Promise<void>;
  getConflicts(householdId: string): Promise<SyncConflict[]>;
  /** Mark open conflicts for one entity as resolved after a successful push. */
  resolveConflicts(householdId: string, collection: SyncCollection, entityId: string): Promise<void>;
  /** Drop one local outbox record after the user chose the remote version. */
  discardLocalRecord(householdId: string, collection: SyncCollection, entityId: string): Promise<void>;
}
