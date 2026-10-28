import { PrivacyReleaseGate } from '../src/analytics/gate';

function product(): any {
  return { productId: 'weekly-aggregate', version: '1', taxonomyVersion: '1', type: 'aggregate', householdCount: 20,
    timeRange: { fromMonth: '2026-01', toMonth: '2026-02' },
    data: Array.from({ length: 20 }, () => ({ type: 'expense', amountBucket: 'small', participantCount: 2, timestamp: { month: '2026-01' } })),
    provenance: { pipelineVersion: '3', taxonomyVersion: '1', producedAt: '2026-02-01T00:00:00Z' } };
}

test('a clean sufficiently populated release remains admissible', () => {
  expect(new PrivacyReleaseGate().validate(product()).approved).toBe(true);
});
for (const field of ['userId', 'note', 'attachments', 'privateUrl']) {
  test(`release rejects nested ${field} in records and metadata`, () => {
    const gate = new PrivacyReleaseGate();
    const release = product();
    release.data[0].demographics = { extra: [{ [field]: 'private-value' }] };
    expect(gate.validate(release).approved).toBe(false);
    const metadata = product();
    metadata.provenance.extra = { [field]: 'private-value' };
    expect(gate.validate(metadata).approved).toBe(false);
    expect(gate.isClean({ extra: [{ [field]: 'private-value' }] }).clean).toBe(false);
  });
}
for (const [field, value] of [['householdCount', NaN], ['householdCount', Infinity], ['householdCount', -1], ['data', {}], ['data', [null]], ['data', []]] as const) {
  test(`malformed ${field} ${String(value)} cannot bypass the release gate`, () => {
    const release = product();
    release[field] = value;
    expect(() => new PrivacyReleaseGate().validate(release)).not.toThrow();
    expect(new PrivacyReleaseGate().validate(release).approved).toBe(false);
  });
}
