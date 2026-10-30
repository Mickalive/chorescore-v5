import { NetworkCost } from '../../domain/services/networkCost';
/**
 * Real Firestore REST client (Firebase Spark friendly).
 *
 * It uses the signed-in user's Firebase ID token as the bearer credential, so
 * no service account, Cloud Function or Blaze billing is involved. Atomic
 * multi-document writes use Firestore read-write transactions; the security
 * rules in `firebase/firestore.rules` are the authority on membership.
 */
import {
  FirestoreConflictError,
  FirestoreDocument,
  FirestoreFilter,
  FirestoreHttpError,
  FirestorePort,
  FirestoreTransaction,
  FirestoreValue,
  FirestoreWrite,
} from './FirestorePort';

const API_ROOT = 'https://firestore.googleapis.com/v1';

function encodeValue(value: FirestoreValue | undefined): Record<string, unknown> {
  if (value === undefined || value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Firestore cannot store a non-finite number');
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map((item) => encodeValue(item)) } };
  }
  const fields: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) fields[key] = encodeValue(item);
  }
  return { mapValue: { fields } };
}

function decodeValue(value: Record<string, unknown> | undefined): FirestoreValue {
  if (!value) return null;
  if ('nullValue' in value) return null;
  if ('stringValue' in value) return String(value.stringValue ?? '');
  if ('booleanValue' in value) return Boolean(value.booleanValue);
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('timestampValue' in value) return String(value.timestampValue ?? '');
  if ('arrayValue' in value) {
    const array = value.arrayValue as { values?: Array<Record<string, unknown>> } | undefined;
    return (array?.values ?? []).map((item) => decodeValue(item));
  }
  if ('mapValue' in value) {
    const map = value.mapValue as { fields?: Record<string, Record<string, unknown>> } | undefined;
    const result: Record<string, FirestoreValue> = {};
    for (const [key, item] of Object.entries(map?.fields ?? {})) {
      result[key] = decodeValue(item);
    }
    return result;
  }
  return null;
}

export function decodeDocument(document: {
  name?: string;
  fields?: Record<string, Record<string, unknown>>;
  updateTime?: string;
}): FirestoreDocument | null {
  if (!document.name) return null;
  const path = document.name.split('/documents/')[1];
  if (!path) return null;
  const fields: Record<string, FirestoreValue> = {};
  for (const [key, value] of Object.entries(document.fields ?? {})) {
    fields[key] = decodeValue(value);
  }
  return { path, fields, updateTime: document.updateTime };
}

function fieldPath(name: string): Record<string, unknown> {
  return { fieldPath: name };
}

function filterBody(filter: FirestoreFilter): Record<string, unknown> {
  const op =
    filter.op === '=='
      ? 'EQUAL'
      : filter.op === '>'
      ? 'GREATER_THAN'
      : filter.op === '>='
      ? 'GREATER_THAN_OR_EQUAL'
      : filter.op === '<'
      ? 'LESS_THAN'
      : filter.op === '<='
      ? 'LESS_THAN_OR_EQUAL'
      : 'ARRAY_CONTAINS';
  return {
    fieldFilter: {
      field: fieldPath(filter.field),
      op,
      value: encodeValue(filter.value as FirestoreValue),
    },
  };
}

export interface FirestoreRestConfig {
  projectId: string;
  getAccessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

class RestTransaction implements FirestoreTransaction {
  readonly writes: FirestoreWrite[] = [];
  constructor(private readonly client: FirestoreRestClient, readonly id: string) {}

  get(path: string): Promise<FirestoreDocument | null> {
    return this.client.batchGetDocument(path, this.id);
  }

  query(
    collectionPath: string,
    filters: FirestoreFilter[] = [],
    options: { orderBy?: string; limit?: number } = {},
  ): Promise<FirestoreDocument[]> {
    return this.client.runQuery(collectionPath, filters, options, this.id);
  }

  set(path: string, fields: Record<string, FirestoreValue>, options: { exists?: boolean } = {}): void {
    this.writes.push({ path, fields, exists: options.exists });
  }

  delete(path: string): void {
    this.writes.push({ path, fields: null, exists: true });
  }
}

export class FirestoreRestClient implements FirestorePort {
  private readonly networkCost = new NetworkCost();
  getNetworkMetrics() { return this.networkCost.snapshot(); }

  private readonly projectId: string;
  private readonly getAccessToken: () => Promise<string | null>;
  private readonly fetchImpl: typeof fetch;

  constructor(config: FirestoreRestConfig) {
    this.projectId = config.projectId.trim();
    this.getAccessToken = config.getAccessToken;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  available(): boolean {
    return this.projectId.length > 0;
  }

  /**
   * Canonical Firestore resource name. JSON bodies (commit names, batchGet,
   * runQuery parent) must carry the literal document id, including the colon
   * used by record documents such as `records/members:abc`. Percent-encoding
   * here would make the rules see `members%3Aabc` and reject every write.
   */
  private documentName(path: string): string {
    const segments = path.split('/').filter(Boolean);
    return `projects/${this.projectId}/databases/(default)/documents/${segments.join('/')}`;
  }

  /** HTTP path for a document; only the URL segments are percent-encoded. */
  private documentUrl(path: string): string {
    const segments = this.documentName(path).split('/');
    return `${API_ROOT}/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
  }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const token = await this.getAccessToken();
    if (!token) throw new FirestoreHttpError(401, 'Firebase authentication required');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25_000);
    const finishCost = this.networkCost.begin('firestore-request', typeof init.body === 'string' ? init.body : '');
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
      const text = await response.text();
      finishCost(text,response.ok);
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (!response.ok) {
        const error = parsed as { error?: { status?: string; message?: string } } | null;
        const status = error?.error?.status ?? '';
        if (response.status === 409 || status === 'ABORTED' || status === 'FAILED_PRECONDITION') {
          throw new FirestoreConflictError(error?.error?.message);
        }
        throw new FirestoreHttpError(
          response.status,
          error?.error?.message || `Firestore request failed (${response.status})`,
        );
      }
      return parsed as T;
    } catch (error) {
      finishCost();
      if (error instanceof FirestoreConflictError || error instanceof FirestoreHttpError) throw error;
      if ((error as { name?: string }).name === 'AbortError') {
        throw new FirestoreHttpError(408, 'Firestore request timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getDocument(path: string): Promise<FirestoreDocument | null> {
    return this.readDocument(path);
  }

  async readDocument(path: string): Promise<FirestoreDocument | null> {
    try {
      const document = await this.request<{
        name?: string;
        fields?: Record<string, Record<string, unknown>>;
        updateTime?: string;
      }>(this.documentUrl(path));
      return decodeDocument(document);
    } catch (error) {
      if (error instanceof FirestoreHttpError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * Reads a document inside a transaction through `documents:batchGet`.
   *
   * The Firestore emulator hangs on `GET documents/{name}?transaction=...`
   * (its JSON transcoder cannot map the BYTE_STRING query parameter). The
   * batchGet body carries the same transaction id and works against both the
   * emulator and production Firestore, so transactions stay real and atomic.
   */
  async batchGetDocument(path: string, transaction: string): Promise<FirestoreDocument | null> {
    const rows = await this.request<Array<{
      found?: {
        name?: string;
        fields?: Record<string, Record<string, unknown>>;
        updateTime?: string;
      };
      missing?: string;
    }>>(
      `${API_ROOT}/projects/${encodeURIComponent(this.projectId)}/databases/(default)/documents:batchGet`,
      {
        method: 'POST',
        body: JSON.stringify({ documents: [this.documentName(path)], transaction }),
      },
    );
    const found = rows.find((row) => row.found)?.found;
    return found ? decodeDocument(found) : null;
  }

  async query(
    collectionPath: string,
    filters: FirestoreFilter[] = [],
    options: { orderBy?: string; limit?: number } = {},
  ): Promise<FirestoreDocument[]> {
    return this.runQuery(collectionPath, filters, options);
  }

  async runQuery(
    collectionPath: string,
    filters: FirestoreFilter[] = [],
    options: { orderBy?: string; limit?: number } = {},
    transaction?: string,
  ): Promise<FirestoreDocument[]> {
    const segments = collectionPath.split('/').filter(Boolean);
    const collectionId = segments.pop();
    if (!collectionId) throw new Error('A collection path is required');
    const parent = this.documentName(segments.join('/'));
    const parentUrl = `${API_ROOT}/${parent
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')}:runQuery`;
    const structuredQuery: Record<string, unknown> = {
      from: [{ collectionId }],
    };
    if (filters.length > 0) {
      structuredQuery.where =
        filters.length === 1
          ? filterBody(filters[0])
          : { compositeFilter: { op: 'AND', filters: filters.map(filterBody) } };
    }
    if (options.orderBy) {
      structuredQuery.orderBy = [{ field: fieldPath(options.orderBy), direction: 'ASCENDING' }];
    }
    if (options.limit) structuredQuery.limit = options.limit;
    const result = await this.request<Array<{ document?: Parameters<typeof decodeDocument>[0] }>>(
      parentUrl,
      {
        method: 'POST',
        body: JSON.stringify({ parent, structuredQuery, ...(transaction ? { transaction } : {}) }),
      },
    );
    return result
      .map((row) => (row.document ? decodeDocument(row.document) : null))
      .filter((row): row is FirestoreDocument => Boolean(row));
  }

  private decodeWrite(write: FirestoreWrite): Record<string, unknown> {
    if (write.fields === null) {
      return {
        delete: this.documentName(write.path),
        ...(write.exists === true ? { currentDocument: { exists: true } } : {}),
      };
    }
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(write.fields)) {
      fields[key] = encodeValue(value);
    }
    return {
      update: { name: this.documentName(write.path), fields },
      ...(write.exists === undefined
        ? {}
        : { currentDocument: { exists: write.exists } }),
    };
  }

  private async rollbackTransaction(transaction: string): Promise<void> {
    await this.request(
      `${API_ROOT}/projects/${encodeURIComponent(this.projectId)}/databases/(default)/documents:rollback`,
      { method: 'POST', body: JSON.stringify({ transaction }) },
    );
  }

  async runTransaction<T>(operation: (transaction: FirestoreTransaction) => Promise<T>): Promise<T> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const started = await this.request<{ transaction?: string }>(
        `${API_ROOT}/projects/${this.projectId}/databases/(default)/documents:beginTransaction`,
        { method: 'POST', body: JSON.stringify({ options: { readWrite: {} } }) },
      );
      if (!started.transaction) throw new FirestoreHttpError(500, 'Firestore did not start a transaction');
      const transaction = new RestTransaction(this, started.transaction);
      try {
        const result = await operation(transaction);
        await this.request(
          `${API_ROOT}/projects/${this.projectId}/databases/(default)/documents:commit`,
          {
            method: 'POST',
            body: JSON.stringify({
              transaction: started.transaction,
              writes: transaction.writes.map((write) => this.decodeWrite(write)),
            }),
          },
        );
        return result;
      } catch (error) {
        lastError = error;
        // An abandoned read-write transaction keeps its document locks until
        // the emulator/production times it out, blocking every later write to
        // the same group. Roll it back explicitly before retrying or rethrowing
        // so a rule denial or a domain error cannot stall the next transaction.
        await this.rollbackTransaction(started.transaction).catch(() => undefined);
        if (!(error instanceof FirestoreConflictError)) throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new FirestoreConflictError();
  }
}
