import { costTracker } from './costInstrumentation';

/** Numeric session counters only. Never retain URLs, tokens or payloads.
 * Bytes cover UTF-8 bodies, not headers/TLS or Google's billable-rule reads.
 */
export interface NetworkMetrics { requests: number; failures: number; sentBytes: number; receivedBytes: number; }
export function utf8Length(value: string): number {
  let bytes=0;
  for (let i=0;i<value.length;i++) {
    const code=value.charCodeAt(i);
    if (code<0x80) bytes++;
    else if (code<0x800) bytes+=2;
    else if (code>=0xd800 && code<=0xdbff && i+1<value.length && value.charCodeAt(i+1)>=0xdc00 && value.charCodeAt(i+1)<=0xdfff) { bytes+=4; i++; }
    else bytes+=3;
  }
  return bytes;
}
export class NetworkCost {
  private totals: NetworkMetrics = { requests:0,failures:0,sentBytes:0,receivedBytes:0 };
  snapshot(): NetworkMetrics { return { ...this.totals }; }
  begin(kind: 'firestore-request'|'collaboration-request',body='') {
    const sent=utf8Length(body);
    this.totals.requests++; this.totals.sentBytes+=sent;
    const handle=costTracker.start(kind);
    let done=false;
    return (response='',ok=false) => {
      if (done) return;
      done=true;
      const received=utf8Length(response);
      this.totals.receivedBytes+=received;
      if (!ok) this.totals.failures++;
      handle.recordNetwork(sent+received); handle.finish();
    };
  }
}
export function combineNetworkMetrics(...values: (NetworkMetrics|undefined)[]): NetworkMetrics {
  return values.reduce<NetworkMetrics>((sum,value)=>({requests:sum.requests+(value?.requests??0),failures:sum.failures+(value?.failures??0),
    sentBytes:sum.sentBytes+(value?.sentBytes??0),receivedBytes:sum.receivedBytes+(value?.receivedBytes??0)}),{requests:0,failures:0,sentBytes:0,receivedBytes:0});
}
