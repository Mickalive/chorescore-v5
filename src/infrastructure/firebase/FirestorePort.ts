/**
 * Small provider-neutral Firestore port.
 *
 * The collaboration adapter is written against this port so its rules can be
 * exercised without a network, while `FirestoreRestClient` implements the real
 * Firebase Firestore REST API used on Spark (no server, no Cloud Functions).
 */
export type FirestoreScalar = string | number | boolean | null;
export type FirestoreValue =
  | FirestoreScalar
  | FirestoreValue[]
  | { [key: string]: FirestoreValue | undefined };

export interface FirestoreDocument {
  path: string;
  fields: Record<string, FirestoreValue>;
  updateTime?: string;
}

export type FirestoreOperator = '==' | '>' | '>=' | '<' | '<=' | 'array-contains';

export interface FirestoreFilter {
  field: string;
  op: FirestoreOperator;
  value: FirestoreScalar | FirestoreScalar[];
}

export interface FirestoreWrite {
  path: string;
  /** `null` means delete. */
  fields: Record<string, FirestoreValue> | null;
  /** Require the document to be absent (create) or present (update). */
  exists?: boolean;
}

export interface FirestoreTransaction {
  get(path: string): Promise<FirestoreDocument | null>;
  query(
    collectionPath: string,
    filters?: FirestoreFilter[],
    options?: { orderBy?: string; limit?: number },
  ): Promise<FirestoreDocument[]>;
  set(path: string, fields: Record<string, FirestoreValue>, options?: { exists?: boolean }): void;
  delete(path: string): void;
}

export interface FirestorePort {
  available(): boolean;
  getDocument(path: string): Promise<FirestoreDocument | null>;
  query(
    collectionPath: string,
    filters?: FirestoreFilter[],
    options?: { orderBy?: string; limit?: number },
  ): Promise<FirestoreDocument[]>;
  runTransaction<T>(operation: (transaction: FirestoreTransaction) => Promise<T>): Promise<T>;
}

export class FirestoreConflictError extends Error {
  constructor(message = 'Firestore transaction conflict') {
    super(message);
    this.name = 'FirestoreConflictError';
  }
}

export class FirestoreHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'FirestoreHttpError';
  }
}
