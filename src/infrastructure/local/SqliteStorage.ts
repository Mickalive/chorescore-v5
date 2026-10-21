/**
 * ChoreScore V3 — SQLite Storage
 *
 * expo-sqlite based local-first storage with proper indexes.
 * All business data lives here, indexed for fast queries.
 * Navigation reads from this local store without network dependency.
 */

import * as SQLite from 'expo-sqlite';

let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDatabase(): Promise<SQLite.SQLiteDatabase> {
  if (!databasePromise) {
    databasePromise = (async () => {
      const database = await SQLite.openDatabaseAsync('chorescore.db');
      try {
        await initializeSchema(database);
        await applyV4ColumnMigrations(database);
        await initializeAttachmentLinks(database);
        return database;
      } catch (error) {
        await database.closeAsync();
        throw error;
      }
    })().catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

export async function initializeSchema(database: SQLite.SQLiteDatabase): Promise<void> {
  await database.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      displayName TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS households (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      ownerId TEXT NOT NULL,
      contributionUnit TEXT NOT NULL DEFAULT 'minutes',
      crossLedgerCompensationEnabled INTEGER NOT NULL DEFAULT 0,
      contributionToMoneyRateJson TEXT,
      createdAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memberships (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      householdId TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'MEMBER',
      joinedAt TEXT NOT NULL,
      UNIQUE(userId, householdId)
    );

    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      householdId TEXT NOT NULL,
      name TEXT NOT NULL,
      -- V4-01: '' encodes a named member (no account yet) so the NOT NULL
      -- constraint of existing installs stays intact after migration.
      userId TEXT NOT NULL,
      joinedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contribution_entries (
      id TEXT PRIMARY KEY,
      householdId TEXT NOT NULL,
      label TEXT NOT NULL,
      performedByMemberId TEXT NOT NULL,
      beneficiaryMemberIds TEXT NOT NULL,
      value REAL NOT NULL,
      unit TEXT NOT NULL,
      persistentTaskId TEXT,
      occurredAt TEXT NOT NULL,
      createdBy TEXT NOT NULL,
      modifiedBy TEXT,
      -- V4-01: optional category / attachments / snapshoted custom split
      categoryId TEXT,
      categoryLabelSnapshot TEXT,
      note TEXT,
      attachmentsJson TEXT,
      splitMode TEXT,
      splitWeightsJson TEXT,
      splitSource TEXT
    );

    CREATE TABLE IF NOT EXISTS persistent_tasks (
      id TEXT PRIMARY KEY,
      householdId TEXT NOT NULL,
      name TEXT NOT NULL,
      defaultValue REAL NOT NULL DEFAULT 1,
      defaultUnit TEXT NOT NULL DEFAULT 'minutes',
      defaultBeneficiaryMemberIds TEXT,
      createdAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS todo_items (
      id TEXT PRIMARY KEY,
      householdId TEXT NOT NULL,
      title TEXT NOT NULL,
      assigneeMemberId TEXT,
      beneficiaryMemberIds TEXT NOT NULL,
      dueAt TEXT,
      reminderAt TEXT,
      notes TEXT NOT NULL DEFAULT '',
      persistentTaskId TEXT,
      status TEXT NOT NULL DEFAULT 'todo',
      createdAt TEXT NOT NULL,
      completedAt TEXT,
      -- V4-01: 'task' (default) or 'expense'; a todo completion writes exactly
      -- one entry of the matching kind.
      kind TEXT,
      categoryId TEXT,
      expenseAmountMinor INTEGER,
      expenseCurrency TEXT
    );

    CREATE TABLE IF NOT EXISTS expense_entries (
      id TEXT PRIMARY KEY,
      householdId TEXT NOT NULL,
      title TEXT NOT NULL,
      amountMinor INTEGER NOT NULL,
      currency TEXT NOT NULL,
      paidByMemberId TEXT NOT NULL,
      participantMemberIds TEXT NOT NULL,
      splitMode TEXT NOT NULL DEFAULT 'equal',
      customSharesJson TEXT,
      note TEXT,
      category TEXT,
      occurredAt TEXT NOT NULL,
      createdBy TEXT NOT NULL,
      modifiedBy TEXT,
      -- V4-01: optional user-created category / attachments
      categoryId TEXT,
      categoryLabelSnapshot TEXT,
      attachmentsJson TEXT
    );

    -- V4-01: user-created categories. NO seeded taxonomy: a household starts
    -- with zero rows here and only stores names its members typed.
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      householdId TEXT NOT NULL,
      name TEXT NOT NULL,
      defaultTaskRatioJson TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_categories_household ON categories(householdId);

    CREATE TABLE IF NOT EXISTS settlements (
      id TEXT PRIMARY KEY,
      householdId TEXT NOT NULL,
      contributionCreditorMemberId TEXT NOT NULL,
      counterpartyMemberId TEXT NOT NULL,
      contributionValue REAL NOT NULL,
      contributionUnit TEXT NOT NULL,
      moneyAmountMinor INTEGER NOT NULL,
      currency TEXT NOT NULL,
      rateSnapshotJson TEXT NOT NULL,
      occurredAt TEXT NOT NULL,
      createdBy TEXT NOT NULL
    );

    -- File lifecycle is independent from ledger history. Links are changed by
    -- SQL triggers in the SAME transaction as the entry; failed edits cannot
    -- enqueue deletion of a still-referenced private photo.
    CREATE TABLE IF NOT EXISTS attachment_files (
      ref TEXT PRIMARY KEY,
      createdAt INTEGER NOT NULL,
      committed INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS attachment_links (
      ref TEXT NOT NULL,
      entryId TEXT NOT NULL,
      collection TEXT NOT NULL,
      PRIMARY KEY (ref, entryId, collection)
    );
    CREATE INDEX IF NOT EXISTS idx_attachment_links_entry ON attachment_links(collection, entryId);

    -- Indexes for fast local queries
    CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(userId);
    CREATE INDEX IF NOT EXISTS idx_memberships_household ON memberships(householdId);
    CREATE INDEX IF NOT EXISTS idx_members_household ON members(householdId);
    CREATE INDEX IF NOT EXISTS idx_contributions_household ON contribution_entries(householdId);
    CREATE INDEX IF NOT EXISTS idx_contributions_occurred ON contribution_entries(householdId, occurredAt);
    CREATE INDEX IF NOT EXISTS idx_contributions_unit ON contribution_entries(householdId, unit);
    CREATE INDEX IF NOT EXISTS idx_tasks_household ON persistent_tasks(householdId);
    CREATE INDEX IF NOT EXISTS idx_todos_household ON todo_items(householdId);
    CREATE INDEX IF NOT EXISTS idx_todos_status ON todo_items(householdId, status);
    CREATE INDEX IF NOT EXISTS idx_expenses_household ON expense_entries(householdId);
    CREATE INDEX IF NOT EXISTS idx_expenses_occurred ON expense_entries(householdId, occurredAt);
    CREATE INDEX IF NOT EXISTS idx_settlements_household ON settlements(householdId);

    -- V3-06: Invitations
    CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY,
      householdId TEXT NOT NULL,
      invitedByUserId TEXT NOT NULL,
      invitedEmail TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'MEMBER',
      status TEXT NOT NULL DEFAULT 'pending',
      linkToken TEXT NOT NULL UNIQUE,
      -- V4-09: targeted invitation — accepting links this named member
      -- (same member id, no duplicate) instead of creating a new member.
      targetMemberId TEXT,
      createdAt TEXT NOT NULL,
      expiresAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_invitations_household ON invitations(householdId);
    CREATE INDEX IF NOT EXISTS idx_invitations_link_token ON invitations(linkToken);
    CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(invitedEmail, status);

    CREATE TABLE IF NOT EXISTS sync_sequences (
      householdId TEXT NOT NULL,
      collection TEXT NOT NULL,
      revision INTEGER NOT NULL,
      PRIMARY KEY (householdId, collection)
    );

    -- V3-06: Sync cursors
    CREATE TABLE IF NOT EXISTS sync_cursors (
      householdId TEXT NOT NULL,
      collection TEXT NOT NULL,
      lastRevision INTEGER NOT NULL DEFAULT 0,
      lastSyncedAt TEXT NOT NULL,
      PRIMARY KEY (householdId, collection)
    );

    -- V3-06: Sync records (delta buffer)
    CREATE TABLE IF NOT EXISTS sync_records (
      id TEXT NOT NULL,
      householdId TEXT NOT NULL,
      collection TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updatedAt TEXT NOT NULL,
      deletedAt TEXT,
      payload TEXT,
      PRIMARY KEY (id, collection)
    );
    CREATE INDEX IF NOT EXISTS idx_sync_records_dirty ON sync_records(householdId, collection, revision);
  `);
}

/**
 * V4-01 guarded column migration.
 *
 * `CREATE TABLE IF NOT EXISTS` cannot add columns to a table created by an
 * existing V3 install, so every V4 column is also declared here and added
 * with `ALTER TABLE ... ADD COLUMN` when (and only when) it is missing.
 *
 * Safety rules:
 *   - a column that already exists is never touched (idempotent);
 *   - a driver that cannot answer `PRAGMA table_info` (some test doubles,
 *     a locked/corrupt store) makes the whole step a no-op instead of
 *     failing startup: a fresh install already has the full column set from
 *     `initializeSchema`, and no history is ever rewritten by a skip;
 *   - only additive, nullable/defaulted columns are listed: no rename, no
 *     drop, no reinterpretation of existing values.
 */
export interface ColumnMigration {
  table: string;
  column: string;
  ddl: string;
}

export const V4_COLUMN_MIGRATIONS: ColumnMigration[] = [
  // contribution_entries: category / attachments / snapshoted custom split
  { table: 'contribution_entries', column: 'categoryId', ddl: 'TEXT' },
  { table: 'contribution_entries', column: 'categoryLabelSnapshot', ddl: 'TEXT' },
  { table: 'contribution_entries', column: 'note', ddl: 'TEXT' },
  { table: 'contribution_entries', column: 'attachmentsJson', ddl: 'TEXT' },
  { table: 'contribution_entries', column: 'splitMode', ddl: 'TEXT' },
  { table: 'contribution_entries', column: 'splitWeightsJson', ddl: 'TEXT' },
  { table: 'contribution_entries', column: 'splitSource', ddl: 'TEXT' },
  // expense_entries: category + attachments
  { table: 'expense_entries', column: 'categoryId', ddl: 'TEXT' },
  { table: 'expense_entries', column: 'categoryLabelSnapshot', ddl: 'TEXT' },
  { table: 'expense_entries', column: 'attachmentsJson', ddl: 'TEXT' },
  // todo_items: kind + expense payload
  { table: 'todo_items', column: 'kind', ddl: 'TEXT' },
  { table: 'todo_items', column: 'categoryId', ddl: 'TEXT' },
  { table: 'todo_items', column: 'expenseAmountMinor', ddl: 'INTEGER' },
  { table: 'todo_items', column: 'expenseCurrency', ddl: 'TEXT' },
  // invitations: targeted named-member linkage (V4-09)
  { table: 'invitations', column: 'targetMemberId', ddl: 'TEXT' },
];

type ColumnInfoRow = { name?: unknown };

/**
 * Apply the additive V4 column migrations. Exposed for tests.
 * Returns the number of columns actually added (0 on a fresh install or
 * when the driver cannot introspect the schema).
 */
export async function applyV4ColumnMigrations(
  database: SQLite.SQLiteDatabase,
  migrations: ColumnMigration[] = V4_COLUMN_MIGRATIONS,
): Promise<number> {
  let added = 0;
  for (const migration of migrations) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(migration.table)) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(migration.column)) continue;
    try {
      const info = await database.getAllAsync<ColumnInfoRow>(
        `PRAGMA table_info(${migration.table})`
      );
      if (!Array.isArray(info)) continue;
      if (info.some((column) => column?.name === migration.column)) continue;
      await database.execAsync(
        `ALTER TABLE ${migration.table} ADD COLUMN ${migration.column} ${migration.ddl}`
      );
      added += 1;
    } catch {
      // Introspection unsupported or the statement is not permitted here:
      // skip this column rather than block startup. Fresh installs already
      // have the full schema, and nothing in history is reinterpreted.
    }
  }
  return added;
}

/** Additive file-reference migration; never changes an entry's content. */
export async function initializeAttachmentLinks(database: SQLite.SQLiteDatabase): Promise<void> {
  for (const table of ['contribution_entries', 'expense_entries']) {
    await database.execAsync(`
      CREATE TRIGGER IF NOT EXISTS ${table}_photos_insert AFTER INSERT ON ${table} BEGIN
        INSERT OR IGNORE INTO attachment_files(ref, createdAt, committed)
          SELECT json_extract(value, '$.ref'), 0, 1 FROM json_each(COALESCE(NEW.attachmentsJson, '[]'));
        INSERT OR IGNORE INTO attachment_links(ref, entryId, collection)
          SELECT json_extract(value, '$.ref'), NEW.id, '${table}' FROM json_each(COALESCE(NEW.attachmentsJson, '[]'));
        UPDATE attachment_files SET committed = 1 WHERE ref IN
          (SELECT ref FROM attachment_links WHERE entryId = NEW.id AND collection = '${table}');
      END;
      CREATE TRIGGER IF NOT EXISTS ${table}_photos_update AFTER UPDATE OF attachmentsJson ON ${table} BEGIN
        DELETE FROM attachment_links WHERE entryId = OLD.id AND collection = '${table}';
        INSERT OR IGNORE INTO attachment_files(ref, createdAt, committed)
          SELECT json_extract(value, '$.ref'), 0, 1 FROM json_each(COALESCE(NEW.attachmentsJson, '[]'));
        INSERT OR IGNORE INTO attachment_links(ref, entryId, collection)
          SELECT json_extract(value, '$.ref'), NEW.id, '${table}' FROM json_each(COALESCE(NEW.attachmentsJson, '[]'));
        UPDATE attachment_files SET committed = 1 WHERE ref IN
          (SELECT ref FROM attachment_links WHERE entryId = NEW.id AND collection = '${table}');
      END;
      CREATE TRIGGER IF NOT EXISTS ${table}_photos_delete AFTER DELETE ON ${table} BEGIN
        DELETE FROM attachment_links WHERE entryId = OLD.id AND collection = '${table}';
      END;
    `);
  }
  // Backfill only once; scanning old ledgers is a migration, never a render or
  // normal startup cost. Include both collections in the same transaction.
  await database.execAsync('CREATE TABLE IF NOT EXISTS local_migrations (name TEXT PRIMARY KEY)');
  const migrated = await database.getFirstAsync('SELECT name FROM local_migrations WHERE name = ?', ['attachment-links-v1']);
  if (!migrated) {
    await database.withTransactionAsync(async () => {
      for (const table of ['contribution_entries', 'expense_entries']) {
        await database.execAsync(`
          INSERT OR IGNORE INTO attachment_files(ref, createdAt, committed)
            SELECT json_extract(j.value, '$.ref'), 0, 1 FROM ${table} e, json_each(COALESCE(e.attachmentsJson, '[]')) j;
          INSERT OR IGNORE INTO attachment_links(ref, entryId, collection)
            SELECT json_extract(j.value, '$.ref'), e.id, '${table}' FROM ${table} e, json_each(COALESCE(e.attachmentsJson, '[]')) j;
        `);
      }
      await database.runAsync('INSERT INTO local_migrations(name) VALUES (?)', ['attachment-links-v1']);
    });
  }
}

/**
 * Helper to parse JSON arrays stored as text in SQLite.
 */
export function parseJsonArray<T>(text: string | null): T[] {
  if (!text) return [];
  try {
    return JSON.parse(text) as T[];
  } catch {
    return [];
  }
}

/**
 * Helper to serialize arrays to JSON text for SQLite storage.
 */
export function toJsonArray<T>(items: T[]): string {
  return JSON.stringify(items);
}
