/**
 * Deterministic in-memory implementation of the FirestorePort.
 *
 * It is only a test double for the transport contract: real deployment,
 * security rules and network behavior remain covered by Firebase itself.
 */
import {
  FirestoreConflictError,
  FirestoreDocument,
  FirestoreFilter,
  FirestorePort,
  FirestoreTransaction,
  FirestoreValue,
  FirestoreWrite,
} from '../../src/infrastructure/firebase/FirestorePort';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getField(fields: Record<string, FirestoreValue>, field: string): FirestoreValue {
  return fields[field] ?? null;
}

function compare(actual: FirestoreValue, op: FirestoreFilter['op'], expected: FirestoreFilter['value']): boolean {
  if (op === 'array-contains') {
    return Array.isArray(actual) && actual.includes(expected as FirestoreValue);
  }
  if (typeof actual === 'number' && typeof expected === 'number') {
    if (op === '==') return actual === expected;
    if (op === '>') return actual > expected;
    if (op === '>=') return actual >= expected;
    if (op === '<') return actual < expected;
    return actual <= expected;
  }
  if (op === '==') return actual === expected;
  return false;
}

class InMemoryTransaction implements FirestoreTransaction {
  readonly writes: FirestoreWrite[] = [];
  constructor(private readonly store: InMemoryFirestore) {}

  async get(path: string): Promise<FirestoreDocument | null> {
    return this.store.read(path);
  }

  async query(
    collectionPath: string,
    filters: FirestoreFilter[] = [],
    options: { orderBy?: string; limit?: number } = {},
  ): Promise<FirestoreDocument[]> {
    return this.store.queryDocuments(collectionPath, filters, options);
  }

  set(path: string, fields: Record<string, FirestoreValue>, options: { exists?: boolean } = {}): void {
    this.writes.push({ path, fields, exists: options.exists });
  }

  delete(path: string): void {
    this.writes.push({ path, fields: null, exists: true });
  }
}

export class InMemoryFirestore implements FirestorePort {
  private readonly documents = new Map<string, FirestoreDocument>();

  available(): boolean {
    return true;
  }

  read(path: string): FirestoreDocument | null {
    const document = this.documents.get(path);
    return document ? { path, fields: clone(document.fields) } : null;
  }

  async getDocument(path: string): Promise<FirestoreDocument | null> {
    return this.read(path);
  }

  queryDocuments(
    collectionPath: string,
    filters: FirestoreFilter[] = [],
    options: { orderBy?: string; limit?: number } = {},
  ): FirestoreDocument[] {
    const prefix = `${collectionPath}/`;
    let documents = Array.from(this.documents.values()).filter((document) => {
      if (!document.path.startsWith(prefix)) return false;
      return !document.path.slice(prefix.length).includes('/');
    });
    documents = documents.filter((document) =>
      filters.every((filter) => compare(getField(document.fields, filter.field), filter.op, filter.value)),
    );
    if (options.orderBy) {
      const field = options.orderBy;
      documents.sort((left, right) => {
        const a = getField(left.fields, field);
        const b = getField(right.fields, field);
        return Number(a ?? 0) - Number(b ?? 0);
      });
    }
    if (options.limit) documents = documents.slice(0, options.limit);
    return documents.map((document) => ({ path: document.path, fields: clone(document.fields) }));
  }

  async query(
    collectionPath: string,
    filters: FirestoreFilter[] = [],
    options: { orderBy?: string; limit?: number } = {},
  ): Promise<FirestoreDocument[]> {
    return this.queryDocuments(collectionPath, filters, options);
  }

  async runTransaction<T>(operation: (transaction: FirestoreTransaction) => Promise<T>): Promise<T> {
    const transaction = new InMemoryTransaction(this);
    const result = await operation(transaction);
    for (const write of transaction.writes) {
      const existing = this.documents.get(write.path);
      if (write.exists === false && existing) {
        throw new FirestoreConflictError('Document already exists');
      }
      if (write.exists === true && !existing) {
        throw new FirestoreConflictError('Document does not exist');
      }
      if (write.fields === null) {
        this.documents.delete(write.path);
      } else {
        this.documents.set(write.path, { path: write.path, fields: clone(write.fields) });
      }
    }
    return result;
  }

  /** Test helpers. */
  seed(path: string, fields: Record<string, FirestoreValue>): void {
    this.documents.set(path, { path, fields: clone(fields) });
  }

  dump(): Array<[string, Record<string, FirestoreValue>]> {
    return Array.from(this.documents.entries()).map(([path, document]) => [path, clone(document.fields)]);
  }
}
