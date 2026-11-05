import { NetworkCost, utf8Length } from '../src/domain/services/networkCost';
import { COST_BUDGETS, costTracker } from '../src/domain/services/costInstrumentation';
import { FirestoreRestClient } from '../src/infrastructure/firebase/FirestoreRestClient';
import { RemoteSyncAdapter } from '../src/infrastructure/sync/RemoteSyncAdapter';

beforeEach(() => costTracker.reset());
test('UTF-8 metrics count accents and astral symbols without retaining payloads; completion is idempotent', () => {
  const body='Note privée café 🔐';
  expect(utf8Length(body)).toBe(Buffer.byteLength(body,'utf8'));
  const meter=new NetworkCost(); const finish=meter.begin('collaboration-request',body);
  finish('réponse',true); finish('duplicate',false);
  expect(meter.snapshot()).toEqual({requests:1,failures:0,sentBytes:Buffer.byteLength(body),receivedBytes:Buffer.byteLength('réponse')});
  expect(JSON.stringify(costTracker.getRecords())).not.toContain('privée');
  costTracker.assertBudget('collaboration-request');
});
test('cost gates fail on absent measurements and the latest excessive request, including bytes and classifications', () => {
  expect(() => costTracker.assertBudget('collaboration-request')).toThrow('no measurement');
  const first=costTracker.start('collaboration-request'); first.recordNetwork(1);first.finish();
  const next=costTracker.start('collaboration-request');next.recordNetwork(3*1024*1024);next.finish();
  expect(() => costTracker.assertBudget('collaboration-request')).toThrow('bytesSynced');
  COST_BUDGETS['classification-test']={classifications:0};
  const label=costTracker.start('classification-test');label.recordClassification();label.finish();
  expect(() => costTracker.assertBudget('classification-test')).toThrow('classifications');
  delete COST_BUDGETS['classification-test'];
});
test('diagnostic records have a fixed memory bound', () => {
  for (let i=0;i<2000;i++) costTracker.start('collaboration-request').finish();
  expect(costTracker.getRecords()).toHaveLength(512);
});
test('the actual Firestore REST client measures successful bodies and failed requests without logging credentials', async () => {
  const response=JSON.stringify({name:'projects/p/databases/(default)/documents/groups/g',fields:{name:{stringValue:'Maison privée'}}});
  let fail=false;
  const client=new FirestoreRestClient({projectId:'p',getAccessToken:async()=>'private-test-token',fetchImpl:async()=>{
    if(fail)throw new Error('offline');return {ok:true,status:200,text:async()=>response} as Response;
  }});
  await client.getDocument('groups/g');fail=true;
  await expect(client.getDocument('groups/g')).rejects.toThrow('offline');
  expect(client.getNetworkMetrics()).toEqual({requests:2,failures:1,sentBytes:0,receivedBytes:Buffer.byteLength(response)});
  expect(JSON.stringify(costTracker.getRecords())).not.toMatch(/Maison|private-test-token|groups\/g/);
});
test('the actual HTTP adapter measures invitation calls; missing authentication makes zero requests', async () => {
  let token:string|null='test-token';
  const body=JSON.stringify({token:'A'.repeat(43),expiresAt:'2099-01-01T00:00:00Z'});
  const sync=new RemoteSyncAdapter({baseUrl:'https://example.test',getAccessToken:async()=>token,getRepos:()=>{throw new Error('No local repository needed');},
    fetchImpl:async()=>({ok:true,status:200,text:async()=>body} as Response)});
  await sync.createInvitation('group','named');
  expect(sync.getNetworkMetrics()).toEqual({requests:1,failures:0,sentBytes:Buffer.byteLength(JSON.stringify({memberId:'named'})),receivedBytes:Buffer.byteLength(body)});
  token=null;
  await expect(sync.createInvitation('group','named')).rejects.toThrow();
  expect(sync.getNetworkMetrics()?.requests).toBe(1);
});
