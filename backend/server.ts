import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { FirebaseTokenVerifier, HttpError } from './auth';
import { CollaborationStore, MAX_MEDIA_BYTES } from './store';

async function raw(request: IncomingMessage, limit: number): Promise<Buffer> {
  const buffers: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413,'Request too large');
    buffers.push(chunk);
  }
  return Buffer.concat(buffers);
}
async function body(request: IncomingMessage): Promise<Record<string, any>> {
  const data = await raw(request,1024*1024);
  try {
    const result = JSON.parse(data.toString());
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch { throw new HttpError(400,'Invalid JSON object'); }
}
export function createCollaborationServer(store: CollaborationStore, verifier: FirebaseTokenVerifier) {
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader('Content-Type','application/json');
    response.setHeader('Cache-Control','no-store');
    response.setHeader('X-Content-Type-Options','nosniff');
    try {
      if (request.url === '/health' && request.method === 'GET') { response.end('{"status":"ok"}'); return; }
      const uid = await verifier.verify(request.headers.authorization);
      const url = new URL(request.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const input = request.method === 'POST' ? await body(request) : {};
      let result: unknown;
      // Private media is addressed per group and requires membership on every
      // request. Binary uploads bypass the JSON parser and are size-bounded.
      if (parts[0] === 'groups' && parts.length === 4 && parts[2] === 'media') {
        if (request.method === 'GET') {
          const media = store.getMedia(uid,parts[1],parts[3]);
          response.statusCode = 200;
          response.setHeader('Content-Type',media.mimeType);
          response.setHeader('Content-Length',String(media.bytes.length));
          response.setHeader('Cache-Control','private, max-age=3600');
          response.end(media.bytes);
          return;
        }
        if (request.method === 'PUT') {
          const mimeType = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
          const bytes = await raw(request,MAX_MEDIA_BYTES);
          result = store.putMedia(uid,parts[1],parts[3],mimeType,bytes);
          response.statusCode = 200;
          response.end(JSON.stringify(result));
          return;
        }
        if (request.method === 'DELETE') {
          result = store.deleteMedia(uid,parts[1],parts[3]);
          response.end(JSON.stringify(result));
          return;
        }
        throw new HttpError(405,'Method not allowed');
      }
      if (parts.length === 1 && parts[0] === 'groups' && request.method === 'GET') result = store.listGroups(uid);
      else if (parts.length === 1 && parts[0] === 'groups' && request.method === 'POST') result = store.createGroup(uid,input);
      else if (parts[0] === 'groups' && parts.length === 3 && parts[2] === 'deltas' && request.method === 'GET') result = store.deltas(uid,parts[1],Number(url.searchParams.get('since') ?? 0));
      else if (parts[0] === 'groups' && parts.length === 3 && parts[2] === 'mutations' && request.method === 'POST') result = store.mutate(uid,parts[1],input.operationId,input.changes);
      else if (parts[0] === 'groups' && parts.length === 3 && parts[2] === 'invites' && request.method === 'POST') result = store.createInvite(uid,parts[1],input.memberId);
      else if (parts[0] === 'groups' && parts.length === 5 && parts[2] === 'invites' && parts[4] === 'revoke' && request.method === 'POST') result = store.revokeInvite(uid,parts[1],parts[3]);
      else if (parts[0] === 'invites' && parts.length === 3 && parts[2] === 'accept' && request.method === 'POST') result = store.acceptInvite(uid,parts[1]);
      else if (parts[0] === 'groups' && parts.length === 5 && parts[2] === 'todos' && parts[4] === 'complete' && request.method === 'POST') result = store.complete(uid,parts[1],parts[3],input);
      else throw new HttpError(404,'Endpoint not found');
      response.end(JSON.stringify(result));
    } catch (error) {
      // Never return tokens, stack traces, SQL, other groups or raw payloads.
      response.statusCode = error instanceof HttpError ? error.status : 400;
      response.end(JSON.stringify({error:error instanceof HttpError ? error.message : 'Operation rejected'}));
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000;
  return server;
}
