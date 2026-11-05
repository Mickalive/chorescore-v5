import type { SQLiteDatabase } from 'expo-sqlite';

/** Three local, rebuildable views: lifetime, UTC day, and UTC minute. A local
 * week/month/year starts at a UTC minute, potentially inside a UTC day. Read
 * full days plus just that edge day's minute buckets; never ledger payloads.
 * No device timezone is baked into the cache, so travelling does not corrupt it.
 */
export async function initializeActivityProjections(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`CREATE TABLE IF NOT EXISTS projection_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  for (const [table,bucket] of [
    ['activity_lifetime', "''"],
    ['activity_days', "strftime('%Y-%m-%d',occurredAt)"],
    ['activity_minutes', "strftime('%Y-%m-%dT%H:%M',occurredAt)"],
  ]) {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS ${table} (
        householdId TEXT NOT NULL, unit TEXT NOT NULL, shortcut TEXT NOT NULL,
        bucket TEXT NOT NULL, memberId TEXT NOT NULL, value REAL NOT NULL, count INTEGER NOT NULL,
        PRIMARY KEY(householdId,unit,shortcut,bucket,memberId));
      CREATE INDEX IF NOT EXISTS ${table}_period ON ${table}(householdId,unit,bucket);
    `);
    const apply = (row: 'NEW'|'OLD',sign: number) => {
      const date = bucket.replace('occurredAt',`${row}.occurredAt`);
      return `INSERT INTO ${table}(householdId,unit,shortcut,bucket,memberId,value,count)
        SELECT ${row}.householdId,${row}.unit,COALESCE(${row}.persistentTaskId,''),${date},${row}.performedByMemberId,${row}.value*${sign},${sign}
        WHERE ${date} IS NOT NULL
        ON CONFLICT(householdId,unit,shortcut,bucket,memberId) DO UPDATE SET value=${table}.value+excluded.value,count=${table}.count+excluded.count;
        DELETE FROM ${table} WHERE householdId=${row}.householdId AND unit=${row}.unit
          AND shortcut=COALESCE(${row}.persistentTaskId,'') AND bucket=${date} AND memberId=${row}.performedByMemberId AND count<=0;`;
    };
    await db.execAsync(`
      CREATE TRIGGER IF NOT EXISTS ${table}_insert AFTER INSERT ON contribution_entries BEGIN ${apply('NEW',1)} END;
      CREATE TRIGGER IF NOT EXISTS ${table}_update AFTER UPDATE ON contribution_entries BEGIN ${apply('OLD',-1)} ${apply('NEW',1)} END;
      CREATE TRIGGER IF NOT EXISTS ${table}_delete AFTER DELETE ON contribution_entries BEGIN ${apply('OLD',-1)} END;
    `);
  }
  const ready = await db.getFirstAsync<{value:string}>("SELECT value FROM projection_metadata WHERE key='activity-v1'");
  if (!ready) {
    await db.withTransactionAsync(async () => {
      for (const [table,bucket] of [
        ['activity_lifetime', "''"],['activity_days', "strftime('%Y-%m-%d',occurredAt)"],['activity_minutes', "strftime('%Y-%m-%dT%H:%M',occurredAt)"],
      ]) {
        await db.execAsync(`DELETE FROM ${table};
          INSERT INTO ${table}(householdId,unit,shortcut,bucket,memberId,value,count)
          SELECT householdId,unit,COALESCE(persistentTaskId,''),${bucket},performedByMemberId,SUM(value),COUNT(*)
          FROM contribution_entries WHERE ${bucket} IS NOT NULL GROUP BY householdId,unit,COALESCE(persistentTaskId,''),${bucket},performedByMemberId;`);
      }
      await db.runAsync("INSERT INTO projection_metadata(key,value) VALUES('activity-v1','ready')");
    });
  }
}
