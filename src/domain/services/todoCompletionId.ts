/**
 * Deterministic ledger entry id for an atomic todo completion.
 *
 * Both the mobile client and the server derive `todo-<sha256(todoId)>`, so a
 * retried offline completion can never create a second entry and the server
 * can validate that a completed todo and its ledger row are one operation.
 */
export async function todoCompletionEntryId(todoId: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const bytes = new TextEncoder().encode(todoId);
    const hash = await subtle.digest('SHA-256', bytes);
    return `todo-${Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')}`;
  }
  const ExpoCrypto = await import('expo-crypto');
  const hex = await ExpoCrypto.digestStringAsync(
    ExpoCrypto.CryptoDigestAlgorithm.SHA256,
    todoId,
  );
  return `todo-${hex}`;
}
