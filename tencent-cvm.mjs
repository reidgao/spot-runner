/**
 * The Tencent Cloud CVM API client and the sweep, shared by tencent-runner.mjs
 * (the actions and the command line) and the sweeper Worker (sweeper/).
 *
 * Requests are signed with node:crypto and sent with fetch rather than an SDK,
 * so no third-party package ever runs next to the keys. It runs on Node 20 or
 * later and on Cloudflare Workers with the nodejs_compat flag.
 */
import { createHash, createHmac } from 'node:crypto';

const HOST = 'cvm.tencentcloudapi.com';
const SERVICE = 'cvm';
const API_VERSION = '2017-03-12';
const CONTENT_TYPE = 'application/json; charset=utf-8';
const SIGNED_HEADERS = 'content-type;host;x-tc-action';

/** Every CI machine's name starts with this. */
export const NAME_PREFIX = 'ci-';
/** Longer than any job runs, so a machine this old was left behind. */
export const DEFAULT_MAX_AGE_MINUTES = 75;

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const hmac = (key, text) => createHmac('sha256', key).update(text, 'utf8');

/** The Authorization header of one request (TC3-HMAC-SHA256). */
export function authorization({ secretId, secretKey, action, payload, timestamp }) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const scope = `${date}/${SERVICE}/tc3_request`;
  const canonical = [
    'POST',
    '/',
    '',
    `content-type:${CONTENT_TYPE}`,
    `host:${HOST}`,
    `x-tc-action:${action.toLowerCase()}`,
    '',
    SIGNED_HEADERS,
    sha256(payload),
  ].join('\n');
  const toSign = ['TC3-HMAC-SHA256', timestamp, scope, sha256(canonical)].join('\n');
  const dated = hmac(`TC3${secretKey}`, date).digest();
  const service = hmac(dated, SERVICE).digest();
  const signing = hmac(service, 'tc3_request').digest();
  const signature = hmac(signing, toSign).digest('hex');
  return `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`;
}

/**
 * Returns `cvm(action, params)` for one account and region. A refused call
 * throws an error whose `code` is Tencent Cloud's error code.
 */
export function cvmClient({ secretId, secretKey, region, send = (...args) => fetch(...args) }) {
  if (!secretId || !secretKey) throw new Error('the Tencent Cloud SecretId and SecretKey are not set');
  if (!region) throw new Error('the Tencent Cloud region is not set');
  return async function cvm(action, params = {}) {
    const payload = JSON.stringify(params);
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await send(`https://${HOST}/`, {
      method: 'POST',
      headers: {
        Authorization: authorization({ secretId, secretKey, action, payload, timestamp }),
        'Content-Type': CONTENT_TYPE,
        Host: HOST,
        'X-TC-Action': action,
        'X-TC-Version': API_VERSION,
        'X-TC-Timestamp': String(timestamp),
        'X-TC-Region': region,
      },
      body: payload,
    });
    const { Response: result } = await response.json();
    if (result?.Error) {
      throw Object.assign(new Error(`${action}: ${result.Error.Code}: ${result.Error.Message}`), {
        code: result.Error.Code,
      });
    }
    return result;
  };
}

/** The CI machines (by name prefix) older than the maximum age, as { id, name, ageMinutes }. */
export function staleMachines(instances, { prefixes, maxAgeMinutes, now = Date.now() }) {
  // An empty prefix would match every machine in the account, and an age of
  // zero every CI machine at work.
  if (!Array.isArray(prefixes) || prefixes.length === 0 || prefixes.some((prefix) => !prefix)) {
    throw new Error('the sweep needs at least one machine-name prefix, none of them empty');
  }
  if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes <= 0) {
    throw new Error('the sweep needs a maximum age in minutes above zero');
  }
  return instances
    .filter((item) => prefixes.some((prefix) => item.InstanceName.startsWith(prefix)))
    .map((item) => ({ id: item.InstanceId, name: item.InstanceName, ageMs: now - Date.parse(item.CreatedTime) }))
    .filter((machine) => machine.ageMs > maxAgeMinutes * 60_000)
    .map(({ id, name, ageMs }) => ({ id, name, ageMinutes: Math.floor(ageMs / 60_000) }));
}

/**
 * Destroys every CI machine left behind and returns them. With `dryRun` it
 * only returns what it would destroy.
 */
export async function sweep(cvm, { prefixes = [NAME_PREFIX], maxAgeMinutes = DEFAULT_MAX_AGE_MINUTES, dryRun = false, now } = {}) {
  const { InstanceSet: instances } = await cvm('DescribeInstances', { Limit: 100 });
  const stale = staleMachines(instances, { prefixes, maxAgeMinutes, now });
  if (stale.length > 0 && !dryRun) {
    await cvm('TerminateInstances', { InstanceIds: stale.map((machine) => machine.id) });
  }
  return stale;
}
