/**
 * Tests for tencent-cvm.mjs. Run them with `node --test` (Node 20 or later).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorization, cvmClient, staleMachines, sweep } from './tencent-cvm.mjs';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const minutesAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const machine = (name, minutes, id = `ins-${name}`) => ({ InstanceId: id, InstanceName: name, CreatedTime: minutesAgo(minutes) });

/** A fake CVM API over a list of instances; records every call. */
function fakeCvm(instances) {
  const calls = [];
  const cvm = async (action, params) => {
    calls.push({ action, params });
    return action === 'DescribeInstances' ? { InstanceSet: instances } : {};
  };
  return { cvm, calls };
}

test('a request is signed as v2.1 signed it', () => {
  // The header v2.1's tencent-runner.mjs produced for this request, before
  // the signing moved here. Made-up keys.
  const header = authorization({
    secretId: 'AKIDEXAMPLEEXAMPLEEXAMPLE',
    secretKey: 'ExampleSecretKeyExampleSecretKey',
    action: 'DescribeInstances',
    payload: JSON.stringify({ Limit: 100 }),
    timestamp: 1794900000,
  });
  assert.equal(
    header,
    'TC3-HMAC-SHA256 Credential=AKIDEXAMPLEEXAMPLEEXAMPLE/2026-11-17/cvm/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=1de8c8af23eb917c9fcf11b708fcc33516032791958db68018cb3dca5ca3774c',
  );
});

test('a call goes to the region with the action, and returns the answer', async () => {
  const requests = [];
  const send = async (url, init) => {
    requests.push({ url, init });
    return { json: async () => ({ Response: { InstanceSet: [], RequestId: 'r' } }) };
  };
  const cvm = cvmClient({ secretId: 'id', secretKey: 'key', region: 'ap-hongkong', send });
  const answer = await cvm('DescribeInstances', { Limit: 100 });
  assert.deepEqual(answer.InstanceSet, []);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://cvm.tencentcloudapi.com/');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.body, '{"Limit":100}');
  assert.equal(requests[0].init.headers['X-TC-Action'], 'DescribeInstances');
  assert.equal(requests[0].init.headers['X-TC-Region'], 'ap-hongkong');
  assert.match(requests[0].init.headers.Authorization, /^TC3-HMAC-SHA256 Credential=id\//);
});

test('a refused call throws with the error code', async () => {
  const send = async () => ({ json: async () => ({ Response: { Error: { Code: 'AuthFailure.SecretIdNotFound', Message: 'no such id' } } }) });
  const cvm = cvmClient({ secretId: 'id', secretKey: 'key', region: 'ap-hongkong', send });
  await assert.rejects(cvm('DescribeInstances'), (error) => {
    assert.equal(error.code, 'AuthFailure.SecretIdNotFound');
    assert.equal(error.message, 'DescribeInstances: AuthFailure.SecretIdNotFound: no such id');
    return true;
  });
});

test('a client without keys or a region is refused before any request', () => {
  assert.throws(() => cvmClient({ secretId: '', secretKey: 'key', region: 'ap-hongkong' }), /SecretId and SecretKey/);
  assert.throws(() => cvmClient({ secretId: 'id', secretKey: undefined, region: 'ap-hongkong' }), /SecretId and SecretKey/);
  assert.throws(() => cvmClient({ secretId: 'id', secretKey: 'key', region: '' }), /region/);
});

test('only CI machines older than the maximum age are stale', () => {
  const instances = [
    machine('ci-website-100-1', 76),
    machine('ci-website-101-1', 75),
    machine('ci-website-102-1', 5),
    machine('database', 6000),
    machine('my-ci-box', 6000),
  ];
  assert.deepEqual(staleMachines(instances, { prefixes: ['ci-'], maxAgeMinutes: 75, now: NOW }), [
    { id: 'ins-ci-website-100-1', name: 'ci-website-100-1', ageMinutes: 76 },
  ]);
});

test('every listed prefix is swept', () => {
  const instances = [machine('ci-a-1-1', 90), machine('old-ci-b-1-1', 90), machine('other', 90)];
  const stale = staleMachines(instances, { prefixes: ['ci-', 'old-ci-'], maxAgeMinutes: 75, now: NOW });
  assert.deepEqual(stale.map((item) => item.name), ['ci-a-1-1', 'old-ci-b-1-1']);
});

test('a sweep that could reach machines it must not is refused', () => {
  const instances = [machine('database', 6000)];
  for (const prefixes of [[], [''], ['ci-', ''], undefined, 'ci-']) {
    assert.throws(() => staleMachines(instances, { prefixes, maxAgeMinutes: 75, now: NOW }), /prefix/, JSON.stringify(prefixes));
  }
  for (const maxAgeMinutes of [0, -5, Number.NaN, Infinity, undefined, '75']) {
    assert.throws(() => staleMachines(instances, { prefixes: ['ci-'], maxAgeMinutes, now: NOW }), /maximum age/, String(maxAgeMinutes));
  }
});

test('a sweep destroys the stale machines in one call and returns them', async () => {
  const { cvm, calls } = fakeCvm([machine('ci-a-1-1', 90), machine('ci-b-2-1', 200), machine('ci-c-3-1', 10)]);
  const stale = await sweep(cvm, { now: NOW });
  assert.deepEqual(stale.map((item) => item.id), ['ins-ci-a-1-1', 'ins-ci-b-2-1']);
  assert.deepEqual(calls, [
    { action: 'DescribeInstances', params: { Limit: 100 } },
    { action: 'TerminateInstances', params: { InstanceIds: ['ins-ci-a-1-1', 'ins-ci-b-2-1'] } },
  ]);
});

test('a sweep with nothing stale destroys nothing', async () => {
  const { cvm, calls } = fakeCvm([machine('ci-c-3-1', 10), machine('database', 6000)]);
  assert.deepEqual(await sweep(cvm, { now: NOW }), []);
  assert.deepEqual(calls.map((call) => call.action), ['DescribeInstances']);
});

test('a dry run reports the stale machines and destroys nothing', async () => {
  const { cvm, calls } = fakeCvm([machine('ci-a-1-1', 90)]);
  const stale = await sweep(cvm, { dryRun: true, now: NOW });
  assert.deepEqual(stale.map((item) => item.id), ['ins-ci-a-1-1']);
  assert.deepEqual(calls.map((call) => call.action), ['DescribeInstances']);
});
