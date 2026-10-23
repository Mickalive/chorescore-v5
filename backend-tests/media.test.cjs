const {test}=require('node:test');
const assert=require('node:assert/strict');
const {generateKeyPairSync,sign}=require('node:crypto');
const {mkdtempSync,readFileSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {FirebaseTokenVerifier}=require('../dist-backend/backend/auth');
const {CollaborationStore}=require('../dist-backend/backend/store');
const {createCollaborationServer}=require('../dist-backend/backend/server');
const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const publicKey=keys.publicKey.export({type:'spki',format:'pem'});
function token(uid) {
 const now=Math.floor(Date.now()/1000);
 const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
 const message=encode({alg:'RS256',kid:'test-key'})+'.'+encode({aud:'chorescore-test',iss:'https://securetoken.google.com/chorescore-test',sub:uid,iat:now,auth_time:now,exp:now+3600});
 return message+'.'+sign('RSA-SHA256',Buffer.from(message),keys.privateKey).toString('base64url');
}
const jpeg=extra=>Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]),extra??Buffer.alloc(64)]);

test('HTTP: private media ACL, idempotence, tenant isolation and attachment authority',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'chorescore-media-'));
 const mediaDirectory=join(directory,'media');
 const path=join(directory,'shared.sqlite');
 const store=new CollaborationStore(path,mediaDirectory);
 const verifier=new FirebaseTokenVerifier('chorescore-test',async()=>({'test-key':publicKey}));
 const server=createCollaborationServer(store,verifier);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();rmSync(directory,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`;
 async function json(uid,path,body,method) {
  const response=await fetch(base+path,{method:method??(body?'POST':'GET'),headers:{authorization:'Bearer '+token(uid),'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
  return {status:response.status,data:await response.json()};
 }
 async function media(uid,path,bytes,mimeType,method) {
  const response=await fetch(base+path,{method:method??(bytes?'PUT':'GET'),headers:{authorization:'Bearer '+token(uid),...(mimeType?{'content-type':mimeType}:{})},body:bytes});
  return {status:response.status,bytes:Buffer.from(await response.arrayBuffer()),headers:response.headers};
 }
 const group={id:'home',ownerMemberId:'alice-member',ownerName:'Alice',name:'Maison',unit:'points',members:[{id:'bob-member',name:'Bob'}]};
 assert.equal((await json('alice','/groups',group)).status,200);
 const invite=await json('alice','/groups/home/invites',{memberId:'bob-member'});
 assert.equal((await json('bob',`/invites/${invite.data.token}/accept`,{})).status,200);

 const photo=jpeg();
 const uploaded=await media('alice','/groups/home/media/photo-1',photo,'image/jpeg');
 assert.equal(uploaded.status,200);
 const descriptor=JSON.parse(uploaded.bytes.toString());
 assert.equal(descriptor.id,'photo-1');assert.equal(descriptor.byteSize,photo.length);
 assert.match(descriptor.sha256,/^[a-f0-9]{64}$/);

 assert.equal((await media('bob','/groups/home/media/photo-1')).status,200);
 const fetched=await media('bob','/groups/home/media/photo-1');
 assert.deepEqual(fetched.bytes,photo);
 assert.equal(fetched.headers.get('content-type'),'image/jpeg');
 assert.equal(fetched.headers.get('x-content-type-options'),'nosniff');
 assert.equal((await media('intruder','/groups/home/media/photo-1')).status,403);
 assert.equal((await media('alice','/groups/home/media/photo-1',jpeg(Buffer.alloc(65,1)),'image/jpeg')).status,409);
 assert.equal((await media('alice','/groups/home/media/photo-1',photo,'image/jpeg')).status,200);
 assert.equal((await media('alice','/groups/home/media/nope',Buffer.from('hello'),'image/jpeg')).status,400);
 assert.equal((await media('alice','/groups/home/media/nope',jpeg(),'text/plain')).status,400);
 assert.equal((await media('alice','/groups/home/media/../escape',jpeg(),'image/jpeg')).status,404);
 assert.equal(readFileSync(join(mediaDirectory,'home','photo-1')).length,photo.length);

 const entry={id:'entry',householdId:'home',label:'Cuisine',performedByMemberId:'alice-member',beneficiaryMemberIds:['alice-member','bob-member'],unit:'points',value:10,occurredAt:new Date().toISOString()};
 const localPath='file:///data/user/0/app/cache/local.jpg';
 const attachment={id:'attachment-1',kind:'photo',ref:localPath,remoteRef:'photo-1',mimeType:'image/jpeg',byteSize:photo.length,createdAt:new Date().toISOString()};
 const missing=await json('alice','/groups/home/mutations',{operationId:'op-missing',changes:[{collection:'contribution_entries',id:'entry',baseVersion:0,value:{...entry,attachments:[{...attachment,remoteRef:'not-uploaded'}]}}]});
 assert.equal(missing.status,400);assert.match(missing.data.error,/uploaded/i);
 const written=await json('alice','/groups/home/mutations',{operationId:'op-photo',changes:[{collection:'contribution_entries',id:'entry',baseVersion:0,value:{...entry,attachments:[attachment]}}]});
 assert.equal(written.status,200);
 const stored=written.data.changes[0].value.attachments[0];
 assert.equal(stored.ref,'media:photo-1');assert.equal(stored.remoteRef,'photo-1');
 assert.equal(stored.mimeType,'image/jpeg');assert.equal(stored.byteSize,photo.length);
 assert.ok(!JSON.stringify(written.data).includes('file:///'));
 assert.equal((await media('alice','/groups/home/media/photo-1',undefined,undefined,'DELETE')).status,409);

 // A member of another group can never reference this group's private file.
 const other={id:'other',ownerMemberId:'other-owner',ownerName:'Other',name:'Autre',unit:'points',members:[]};
 assert.equal((await json('alice','/groups',other)).status,200);
 const cross=await json('alice','/groups/other/mutations',{operationId:'op-cross',changes:[{collection:'contribution_entries',id:'entry-other',baseVersion:0,value:{...entry,id:'entry-other',householdId:'other',beneficiaryMemberIds:['other-owner'],attachments:[attachment]}}]});
 assert.equal(cross.status,400);

 // Removing the reference allows explicit deletion; only unreferenced media is collected.
 const cleared=await json('alice','/groups/home/mutations',{operationId:'op-clear',changes:[{collection:'contribution_entries',id:'entry',baseVersion:1,value:{...entry,attachments:[]}}]});
 assert.equal(cleared.status,200);
 assert.equal((await media('alice','/groups/home/media/photo-1',undefined,undefined,'DELETE')).status,200);
 assert.equal((await media('bob','/groups/home/media/photo-1')).status,404);

 const orphan=await media('alice','/groups/home/media/orphan',jpeg(Buffer.alloc(70,2)),'image/jpeg');
 assert.equal(orphan.status,200);
 store.collectMediaGarbage(0);
 assert.equal((await media('bob','/groups/home/media/orphan')).status,404);
});
