import { FirebaseTokenVerifier } from './auth';
import { CollaborationStore } from './store';
import { createCollaborationServer } from './server';
const project = process.env.FIREBASE_PROJECT_ID;
const database = process.env.COLLAB_DATABASE;
if (!project || !database) throw new Error('FIREBASE_PROJECT_ID and COLLAB_DATABASE are required');
const store = new CollaborationStore(database,process.env.MEDIA_DIRECTORY);
const server = createCollaborationServer(store,new FirebaseTokenVerifier(project));
server.listen(Number(process.env.PORT ?? 8787),process.env.BIND_ADDRESS ?? '127.0.0.1');
function stop() { server.close(() => { store.close(); process.exit(0); }); }
process.on('SIGTERM',stop); process.on('SIGINT',stop);
