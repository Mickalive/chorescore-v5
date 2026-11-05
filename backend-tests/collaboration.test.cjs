const {test}=require('node:test');
const assert=require('node:assert/strict');
const {generateKeyPairSync,sign}=require('node:crypto');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {FirebaseTokenVerifier}=require('../dist-backend/backend/auth');
const {CollaborationStore}=require('../dist-backend/backend/store');
const {createCollaborationServer}=require('../dist-backend/backend/server');
const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const publicKey=keys.publicKey.export({type:'spki',format:'pem'});
function token(uid,overrides={}) {
 const now=Math.floor(Date.now()/1000);
 const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
 const message=encode({alg:'RS256',kid:'test-key'})+'.'+encode({aud:'chorescore-test',iss:'https://securetoken.google.com/chorescore-test',sub:uid,iat:now,auth_time:now,exp:now+3600,...overrides});
 return message+'.'+sign('RSA-SHA256',Buffer.from(message),keys.privateKey).toString('base64url');
}
test('HTTP: isolated accounts, targeted invitations, durable deltas, conflict and atomic completion',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'chorescore-server-'));
 const path=join(directory,'shared.sqlite');
 let store=new CollaborationStore(path);
 const verifier=new FirebaseTokenVerifier('chorescore-test',async()=>({'test-key':publicKey}));
 let server=createCollaborationServer(store,verifier);
 async function start(){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));}
 async function stop(){await new Promise(resolve=>server.close(resolve));store.close();}
 await start();
 t.after(async()=>{await stop();rmSync(directory,{recursive:true,force:true});});
 async function request(uid,path,body,rawToken){
  const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:body?'POST':'GET',headers:{authorization:'Bearer '+(rawToken??token(uid)),'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
  return {status:response.status,data:await response.json()};
 }
 const group={id:'home',ownerMemberId:'alice-member',ownerName:'Alice',name:'Maison',unit:'points',members:[{id:'bob-member',name:'Bob'}]};
 assert.equal((await request('alice','/groups',group)).status,200);
 assert.equal((await request('intruder','/groups/home/deltas')).status,403);
 assert.equal((await request('alice','/groups',null,token('alice',{aud:'other-project'}))).status,401);
 assert.equal((await request('alice','/groups',null,token('alice',{exp:1}))).status,401);
 assert.equal((await request('alice','/groups',null,'unsigned.token.signature')).status,401);
 const invite=await request('alice','/groups/home/invites',{memberId:'bob-member'});
 assert.equal(invite.status,200);
 assert.equal((await request('bob',`/invites/${invite.data.token}/accept`,{})).data.memberId,'bob-member');
 assert.equal((await request('bob',`/invites/${invite.data.token}/accept`,{})).status,200);
 assert.equal((await request('intruder',`/invites/${invite.data.token}/accept`,{})).status,409);
 assert.equal((await request('bob','/groups/home/invites',{memberId:'alice-member'})).status,403);
 const initial=(await request('bob','/groups/home/deltas')).data;
 const members=initial.events.flatMap(e=>e.changes).filter(c=>c.collection==='members'&&c.id==='bob-member');
 assert.equal(members.length,2);assert.equal(members[1].value.userId,'bob');
 const cursor=initial.events.at(-1).revision;
 const entry={id:'entry',householdId:'home',label:'Cuisine',performedByMemberId:'alice-member',beneficiaryMemberIds:['alice-member','bob-member'],unit:'points',value:10,occurredAt:new Date().toISOString(),createdBy:'forged'};
 const mutation={operationId:'op-one',changes:[{collection:'contribution_entries',id:'entry',baseVersion:0,value:entry}]};
 const written=await request('alice','/groups/home/mutations',mutation);
 assert.equal(written.status,200);assert.equal(written.data.changes[0].value.createdBy,'alice');
 assert.deepEqual((await request('alice','/groups/home/mutations',mutation)).data,written.data);
 assert.equal((await request('bob','/groups/home/mutations',{...mutation,operationId:'conflict'})).status,409);
 const delta=(await request('bob',`/groups/home/deltas?since=${cursor}`)).data;
 assert.equal(delta.events.length,1);assert.equal(delta.events[0].changes[0].id,'entry');
 const foreign={...entry,id:'foreign',beneficiaryMemberIds:['outsider']};
 assert.equal((await request('bob','/groups/home/mutations',{operationId:'foreign-op',changes:[{collection:'contribution_entries',id:'foreign',baseVersion:0,value:foreign}]})).status,400);
 assert.equal((await request('bob','/groups/home/mutations',{operationId:'acl-forge',changes:[{collection:'memberships',id:'fake',baseVersion:0,value:{}}]})).status,400);
 const todo={id:'todo',householdId:'home',title:'Vaisselle',kind:'task',status:'todo',beneficiaryMemberIds:['alice-member','bob-member'],createdAt:new Date().toISOString(),createdBy:'alice'};
 assert.equal((await request('alice','/groups/home/mutations',{operationId:'todo-create',changes:[{collection:'todo_items',id:'todo',baseVersion:0,value:todo}]})).status,200);
 const completion={performerMemberId:'bob-member',value:6,beneficiaryMemberIds:['alice-member','bob-member']};
 const completed=await Promise.all([request('alice','/groups/home/todos/todo/complete',completion),request('bob','/groups/home/todos/todo/complete',completion)]);
 assert.deepEqual(completed.map(r=>r.status).sort(),[200,409]);
 assert.equal((await request('alice','/groups/home/mutations',{operationId:'reopen',changes:[{collection:'todo_items',id:'todo',baseVersion:2,value:todo}]})).status,409);
 // The entire batch must roll back if any entity is invalid.
 const beforeBatch=(await request('alice','/groups/home/deltas')).data;
 assert.equal((await request('alice','/groups/home/mutations',{operationId:'bad-batch',changes:[
  {collection:'contribution_entries',id:'valid-in-bad-batch',baseVersion:0,value:{...entry,id:'valid-in-bad-batch'}},
  {collection:'contribution_entries',id:'invalid-in-bad-batch',baseVersion:0,value:{...entry,id:'invalid-in-bad-batch',value:-1}}
 ]})).status,400);
 assert.deepEqual((await request('alice','/groups/home/deltas')).data,beforeBatch);
 // Revocation/expiry are enforced by the authority, not by the recipient UI.
 assert.equal((await request('alice','/groups',{...group,id:'other-home',ownerMemberId:'other-owner',members:[{id:'target',name:'Invité'}]})).status,200);
 const revoked=(await request('alice','/groups/other-home/invites',{memberId:'target'})).data;
 assert.equal((await request('bob',`/groups/other-home/invites/${revoked.token}/revoke`,{})).status,403);
 assert.equal((await request('alice',`/groups/other-home/invites/${revoked.token}/revoke`,{})).status,200);
 assert.equal((await request('intruder',`/invites/${revoked.token}/accept`,{})).status,404);
 const expired=(await request('alice','/groups/other-home/invites',{memberId:'target'})).data;
 store.database.prepare('UPDATE invites SET expires=0 WHERE groupId=?').run('other-home');
 assert.equal((await request('intruder',`/invites/${expired.token}/accept`,{})).status,404);
 assert.ok(!JSON.stringify(store.database.prepare('SELECT * FROM invites').all()).includes(expired.token));
 // Pulls page by group revision and never silently omit the final page.
 let pageCursor=(await request('bob','/groups/home/deltas')).data.events.at(-1).revision;
 for(let i=0;i<102;i++) {
  const category={id:`category-${i}`,householdId:'home',name:`Catégorie ${i}`};
  assert.equal((await request('bob','/groups/home/mutations',{operationId:`category-op-${i}`,changes:[{collection:'categories',id:category.id,baseVersion:0,value:category}]})).status,200);
 }
 const firstPage=(await request('bob',`/groups/home/deltas?since=${pageCursor}`)).data;
 assert.equal(firstPage.events.length,100);assert.equal(firstPage.hasMore,true);
 const secondPage=(await request('bob',`/groups/home/deltas?since=${firstPage.events.at(-1).revision}`)).data;
 assert.equal(secondPage.events.length,2);assert.equal(secondPage.hasMore,false);
 const final=(await request('bob','/groups/home/deltas')).data;
 const completionEvents=final.events.filter(e=>e.changes.some(c=>c.collection==='todo_items'&&c.value?.status==='completed'));
 assert.equal(completionEvents.length,1);assert.equal(completionEvents[0].changes.length,2);
 await stop();store=new CollaborationStore(path);server=createCollaborationServer(store,verifier);await start();
 assert.deepEqual((await request('bob','/groups/home/deltas')).data,final);
 assert.equal((await request('intruder','/groups/home/deltas')).status,403);
 assert.deepEqual((await request('alice','/groups/home/mutations',mutation)).data,written.data);
});
