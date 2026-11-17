/**
 * Tests for the sweeper Worker. Run them with `node --test` (Node 20 or later).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run, settings } from './index.js';

const KEYS = { TENCENT_SECRET_ID: 'id', TENCENT_SECRET_KEY: 'key' };
const PUSH = 'https://push.example/device-key';
const HOUR_START = Date.parse('2026-11-17T12:00:00Z');
const MID_HOUR = Date.parse('2026-11-17T12:20:00Z');

const created = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const machine = (name, minutes) => ({ InstanceId: `ins-${name}`, InstanceName: name, CreatedTime: created(minutes) });

/** Stands in for fetch: the CVM API over a list of instances, and the push endpoint. */
function network({ instances = [], error, pushStatus = 200, pushThrows = false } = {}) {
  const actions = [];
  const pushes = [];
  const send = async (url, init) => {
    if (url === PUSH) {
      if (pushThrows) throw new Error('connection reset');
      pushes.push(Object.fromEntries(init.body));
      return { ok: pushStatus === 200, status: pushStatus };
    }
    const action = init.headers['X-TC-Action'];
    actions.push({ action, params: JSON.parse(init.body), region: init.headers['X-TC-Region'] });
    if (error) return { json: async () => ({ Response: { Error: error } }) };
    return { json: async () => ({ Response: action === 'DescribeInstances' ? { InstanceSet: instances } : {} }) };
  };
  return { send, actions, pushes };
}

test('the settings default to Hong Kong, ci- machines and 75 minutes', () => {
  assert.deepEqual(settings({}), { region: 'ap-hongkong', prefixes: ['ci-'], maxAgeMinutes: 75, dryRun: false });
  assert.deepEqual(settings({ TENCENT_REGION: 'ap-singapore', SWEEP_PREFIXES: 'ci-  old-ci-', MAX_AGE_MINUTES: '90', DRY_RUN: '1' }), {
    region: 'ap-singapore',
    prefixes: ['ci-', 'old-ci-'],
    maxAgeMinutes: 90,
    dryRun: true,
  });
});

test('with nothing left behind it destroys nothing and sends no push', async () => {
  const { send, actions, pushes } = network({ instances: [machine('ci-website-1-1', 10), machine('database', 6000)] });
  assert.deepEqual(await run({ ...KEYS, NOTIFY_URL: PUSH }, { scheduledTime: HOUR_START, send }), []);
  assert.deepEqual(actions.map((call) => call.action), ['DescribeInstances']);
  assert.equal(actions[0].region, 'ap-hongkong');
  assert.deepEqual(pushes, []);
});

test('a machine left behind is destroyed and told', async () => {
  const { send, actions, pushes } = network({ instances: [machine('ci-website-1-1', 120), machine('ci-website-2-1', 10)] });
  const stale = await run({ ...KEYS, NOTIFY_URL: PUSH }, { scheduledTime: MID_HOUR, send });
  assert.deepEqual(stale.map((item) => item.id), ['ins-ci-website-1-1']);
  assert.deepEqual(actions.at(-1), { action: 'TerminateInstances', params: { InstanceIds: ['ins-ci-website-1-1'] }, region: 'ap-hongkong' });
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, 'CI sweeper destroyed a machine');
  assert.match(pushes[0].body, /^Destroyed ci-website-1-1 \(ins-ci-website-1-1, 1[12]\d minutes old\)\./);
  assert.equal(pushes[0].group, 'ci');
});

test('a dry run destroys nothing and says what it would destroy', async () => {
  const { send, actions, pushes } = network({ instances: [machine('ci-website-1-1', 120)] });
  await run({ ...KEYS, NOTIFY_URL: PUSH, DRY_RUN: '1' }, { scheduledTime: MID_HOUR, send });
  assert.deepEqual(actions.map((call) => call.action), ['DescribeInstances']);
  assert.equal(pushes[0].title, 'CI sweeper, dry run');
  assert.match(pushes[0].body, /^Would destroy ci-website-1-1 /);
});

test('without a push URL it still sweeps', async () => {
  const { send, actions, pushes } = network({ instances: [machine('ci-website-1-1', 120)] });
  await run(KEYS, { scheduledTime: MID_HOUR, send });
  assert.equal(actions.at(-1).action, 'TerminateInstances');
  assert.deepEqual(pushes, []);
});

test('a push that fails does not fail the sweep', async () => {
  for (const options of [{ pushStatus: 500 }, { pushThrows: true }]) {
    const { send, actions } = network({ instances: [machine('ci-website-1-1', 120)], ...options });
    const stale = await run({ ...KEYS, NOTIFY_URL: PUSH }, { scheduledTime: MID_HOUR, send });
    assert.equal(stale.length, 1);
    assert.equal(actions.at(-1).action, 'TerminateInstances');
  }
});

test('a failing sweep throws every time and is told once an hour', async () => {
  const error = { Code: 'AuthFailure.SignatureFailure', Message: 'bad signature' };
  const first = network({ error });
  await assert.rejects(run({ ...KEYS, NOTIFY_URL: PUSH }, { scheduledTime: HOUR_START, send: first.send }), /AuthFailure\.SignatureFailure/);
  assert.equal(first.pushes.length, 1);
  assert.equal(first.pushes[0].title, 'CI sweeper failed');
  assert.match(first.pushes[0].body, /^DescribeInstances: AuthFailure\.SignatureFailure: bad signature\./);

  const later = network({ error });
  await assert.rejects(run({ ...KEYS, NOTIFY_URL: PUSH }, { scheduledTime: MID_HOUR, send: later.send }), /AuthFailure\.SignatureFailure/);
  assert.deepEqual(later.pushes, []);
});

test('missing keys and unsafe settings fail before any request', async () => {
  for (const env of [{}, { ...KEYS, MAX_AGE_MINUTES: '0' }, { ...KEYS, MAX_AGE_MINUTES: 'soon' }]) {
    const { send, actions } = network({ instances: [machine('ci-website-1-1', 120)] });
    await assert.rejects(run(env, { scheduledTime: MID_HOUR, send }));
    assert.deepEqual(actions.filter((call) => call.action === 'TerminateInstances'), [], JSON.stringify(env));
  }
});
