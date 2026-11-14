#!/usr/bin/env node
/**
 * Buys, deletes and sweeps the Google Cloud spot VMs that run GitHub Actions
 * jobs as ephemeral self-hosted runners, and bakes the image they boot from.
 *
 *   node gcp-runner.mjs start    buy a VM, wait for its runner
 *   node gcp-runner.mjs stop     delete it, remove its runner
 *   node gcp-runner.mjs sweep    delete any CI VM left behind
 *   node gcp-runner.mjs bake     build a fresh boot image for this repository
 *   node gcp-runner.mjs network  create the network (no inbound rules)
 *
 * Called by the gcp/* actions in this repository, which pass every setting as
 * an environment variable. In GitHub Actions it signs in without a stored key:
 * the job's OIDC token is exchanged for a Google token through Workload
 * Identity Federation, and for a service account's token when one is given
 * (the job needs `permissions: id-token: write`). Locally, set
 * GCP_ACCESS_TOKEN, for example to $(gcloud auth print-access-token). Only
 * fetch is used, so no third-party package runs next to the token.
 * docs/gcp.md has the setup.
 */
import { BAKE_DONE, BAKE_FAILED, bakeScript, bootScript } from './boot-scripts.mjs';
import {
  NAME_PREFIX,
  latestRunnerVersion,
  machineName,
  registrationToken,
  removeRunner,
  repoSlug,
  required,
  run,
  setOutputs,
  setting,
  sizes,
  stamp,
  waitFor,
  waitForRunner,
  words,
} from './common.mjs';

const COMPUTE = 'https://compute.googleapis.com/compute/v1';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const NETWORK = 'ci-runner';
const LABEL = 'ci-runner';
const PUBLIC_IMAGE = 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64';
const DEFAULT_SIZES = '[{"type":"c4d-highcpu-96"},{"type":"c4d-highcpu-48"}]';
const DEFAULT_BUILDER_TYPES = 'c4d-highcpu-4 n2-highcpu-4 e2-standard-4';
// These series boot only from Hyperdisk and need the gVNIC network card.
const THIRD_GENERATION = /^(c4|c4a|c4d|n4|n4a|n4d|h4d|m4|x4|z4)-/;
const MAX_ATTEMPTS = 8;
const BAKE_TIMEOUT_MS = 30 * 60_000;

const project = () => required('GCP_PROJECT');
const region = () => setting('GCP_REGION', 'us-central1');
/** Each repository bakes, boots from and prunes only its own image family. */
const family = () => setting('SPOT_IMAGE_FAMILY', `ci-runner-${repoSlug()}`);
const last = (url) => url.split('/').pop();
const tail = (text, lines = 40) => text.split('\n').slice(-lines).join('\n');

/* ── Signing in ──────────────────────────────────────────────────────── */

let cachedToken = '';

async function postJson(url, body, token) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${url}: ${response.status} ${json.error_description ?? json.error?.message ?? ''}`);
  }
  return json;
}

async function githubOidcToken(audience) {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  if (!url) {
    throw new Error('no GitHub OIDC token: give the job `permissions: id-token: write`, or set GCP_ACCESS_TOKEN');
  }
  const response = await fetch(`${url}&audience=${encodeURIComponent(audience)}`, {
    headers: { Authorization: `Bearer ${required('ACTIONS_ID_TOKEN_REQUEST_TOKEN')}` },
  });
  if (!response.ok) throw new Error(`GitHub OIDC token: ${response.status}`);
  return (await response.json()).value;
}

/** GitHub OIDC token → federated token (STS) → the service account's token, if one is given. */
async function accessToken() {
  if (cachedToken) return cachedToken;
  if (process.env.GCP_ACCESS_TOKEN) return (cachedToken = process.env.GCP_ACCESS_TOKEN);
  const provider = required('GCP_WORKLOAD_IDENTITY_PROVIDER');
  const federated = await postJson('https://sts.googleapis.com/v1/token', {
    grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
    audience: `//iam.googleapis.com/${provider}`,
    scope: SCOPE,
    requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
    subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
    subjectToken: await githubOidcToken(`https://iam.googleapis.com/${provider}`),
  });
  const account = process.env.GCP_SERVICE_ACCOUNT;
  if (!account) return (cachedToken = federated.access_token);
  const impersonated = await postJson(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(account)}:generateAccessToken`,
    { scope: [SCOPE], lifetime: '3600s' },
    federated.access_token,
  );
  return (cachedToken = impersonated.accessToken);
}

/* ── Compute Engine API ──────────────────────────────────────────────── */

async function compute(method, path, body) {
  const url = path.startsWith('https://') ? path : `${COMPUTE}/projects/${project()}/${path}`;
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 404 && method === 'GET') return null;
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(`${method} ${path}: ${response.status} ${json.error?.message ?? ''}`), {
      status: response.status,
      reason: json.error?.errors?.[0]?.reason ?? '',
    });
  }
  return json;
}

/** Waits for a zone or global operation and throws its error, such as a stockout. */
async function done(operation) {
  const scope = operation.zone ? `zones/${last(operation.zone)}` : 'global';
  let current = operation;
  while (current.status !== 'DONE') current = await compute('POST', `${scope}/operations/${operation.name}/wait`);
  if (current.error) {
    const errors = current.error.errors ?? [];
    throw Object.assign(new Error(errors.map((item) => `${item.code}: ${item.message}`).join('; ')), {
      reason: errors[0]?.code ?? '',
    });
  }
  return current;
}

/* ── Network: auto-mode VPC with no firewall rules, so nothing reaches in ── */

async function ensureNetwork() {
  if (await compute('GET', `global/networks/${NETWORK}`)) return;
  await done(
    await compute('POST', 'global/networks', {
      name: NETWORK,
      autoCreateSubnetworks: true,
      description: 'CI spot runners: no firewall rules, so no inbound traffic',
    }),
  );
  console.info(`Created network ${NETWORK}`);
}

/* ── Choosing and launching a VM ─────────────────────────────────────── */

/** The region's zones that offer each wanted type, in order of preference. */
async function offers(wanted) {
  const zones = (await compute('GET', `regions/${region()}`)).zones.map(last).sort();
  const checks = wanted.flatMap((size) => zones.map((zone) => ({ zone, type: size.type, size })));
  const found = await Promise.all(
    checks.map(async (offer) => ((await compute('GET', `zones/${offer.zone}/machineTypes/${offer.type}`)) ? offer : null)),
  );
  return found.filter(Boolean);
}

async function bootImage() {
  const own = await compute('GET', `global/images/family/${family()}`);
  if (own?.status === 'READY') return { image: own.selfLink, baked: true, label: own.name };
  return { image: PUBLIC_IMAGE, baked: false, label: last(PUBLIC_IMAGE) };
}

/**
 * Runners are spot VMs that Google Cloud deletes when it reclaims them and
 * when maxMinutes have passed, even if the stop job never runs. The image
 * builder is a standard VM that only stops, so its disk stays for the image.
 */
function instanceBody({ offer, name, image, script, diskGb, spot, maxMinutes }) {
  const third = THIRD_GENERATION.test(offer.type);
  return {
    name,
    machineType: `zones/${offer.zone}/machineTypes/${offer.type}`,
    labels: { [LABEL]: repoSlug() },
    scheduling: {
      provisioningModel: spot ? 'SPOT' : 'STANDARD',
      instanceTerminationAction: spot ? 'DELETE' : 'STOP',
      maxRunDuration: { seconds: String(maxMinutes * 60) },
      automaticRestart: false,
      onHostMaintenance: 'TERMINATE',
    },
    disks: [
      {
        boot: true,
        autoDelete: true,
        initializeParams: {
          diskName: name,
          sourceImage: image,
          diskSizeGb: String(diskGb),
          diskType: `zones/${offer.zone}/diskTypes/${third ? 'hyperdisk-balanced' : 'pd-balanced'}`,
        },
      },
    ],
    networkInterfaces: [
      {
        network: `global/networks/${NETWORK}`,
        ...(third ? { nicType: 'GVNIC' } : {}),
        accessConfigs: [{ type: 'ONE_TO_ONE_NAT', name: 'External NAT' }],
      },
    ],
    // No service account, so jobs on the VM get no Google Cloud credentials.
    serviceAccounts: [],
    metadata: { items: [{ key: 'startup-script', value: script }] },
  };
}

const isSignInError = (error) =>
  error.status === 401 || (error.status === 403 && !/quota/i.test(`${error.reason} ${error.message}`));

async function launch(candidates, build) {
  const failures = [];
  for (const offer of candidates.slice(0, MAX_ATTEMPTS)) {
    try {
      console.info(`Trying ${offer.type} in ${offer.zone}`);
      await done(await compute('POST', `zones/${offer.zone}/instances`, build(offer)));
      return offer;
    } catch (error) {
      if (isSignInError(error)) throw error;
      console.warn(error.message);
      failures.push(error.message);
    }
  }
  throw new Error(`no VM could be bought:\n${failures.join('\n')}`);
}

const instance = (zone, name) => compute('GET', `zones/${zone}/instances/${name}`);

async function destroy(zone, name) {
  try {
    await done(await compute('DELETE', `zones/${zone}/instances/${name}`));
    console.info(`Deleted ${zone}/${name}`);
  } catch (error) {
    if (error.status !== 404) throw error;
    console.info(`${zone}/${name} is already gone`);
  }
}

/* ── Commands ────────────────────────────────────────────────────────── */

async function start() {
  const repo = required('GITHUB_REPOSITORY');
  const name = machineName();
  const candidates = await offers(sizes(DEFAULT_SIZES, 'c4d-highcpu-96'));
  if (candidates.length === 0) throw new Error(`none of the wanted types is offered in ${region()}`);
  console.info(`${candidates.length} offers; first choice: ${candidates[0].type} in ${candidates[0].zone}`);

  const [, image, token, runnerVersion] = await Promise.all([
    ensureNetwork(),
    bootImage(),
    registrationToken(repo),
    latestRunnerVersion(),
  ]);
  console.info(`Booting from ${image.baked ? 'baked image' : 'public image'} ${image.label}`);
  const script = bootScript({ repo, token, name, runnerVersion, images: words('SPOT_PREPULL_IMAGES') });
  const diskGb = Number(setting('SPOT_DISK_GB', '100'));
  const maxMinutes = Number(setting('SPOT_MAX_RUN_MINUTES', '90'));
  const boughtAt = Date.now();
  const offer = await launch(candidates, (item) =>
    instanceBody({ offer: item, name, image: image.image, script, diskGb, spot: true, maxMinutes }),
  );
  console.info(`Bought ${offer.zone}/${name}: ${offer.type}`);
  setOutputs({ 'instance-id': `${offer.zone}/${name}`, label: name, size: JSON.stringify(offer.size) });

  try {
    await waitForRunner({
      repo,
      name,
      boughtAt,
      isRunning: async () => (await instance(offer.zone, name))?.status === 'RUNNING',
    });
    setOutputs({ ready: 'true' });
  } catch (error) {
    await destroy(offer.zone, name);
    throw error;
  }
}

async function stop() {
  const repo = required('GITHUB_REPOSITORY');
  const [zone, name] = required('INSTANCE_ID').split('/');
  await destroy(zone, name);
  await removeRunner(repo, required('RUNNER_LABEL'));
}

/** Deletes old VMs that carry this tool's label and a sweep prefix, in every zone. */
async function sweep() {
  const maxAgeMs = Number(setting('SPOT_MAX_AGE_MINUTES', '75')) * 60_000;
  const prefixes = words('SPOT_SWEEP_PREFIXES', NAME_PREFIX);
  const { items = {} } = await compute('GET', 'aggregated/instances?maxResults=500');
  const stale = Object.values(items)
    .flatMap((scope) => scope.instances ?? [])
    .filter(
      (item) =>
        item.labels?.[LABEL] &&
        prefixes.some((prefix) => item.name.startsWith(prefix)) &&
        Date.now() - Date.parse(item.creationTimestamp) > maxAgeMs,
    );
  if (stale.length === 0) {
    console.info('No CI machine left behind');
    return;
  }
  for (const item of stale) await destroy(last(item.zone), item.name);
}

/**
 * Follows the builder's serial port output, so a failed bake stops the wait
 * at once instead of after the timeout.
 */
async function watchBake(zone, name) {
  let log = '';
  let next = 0;
  const read = async () => {
    try {
      const output = await compute('GET', `zones/${zone}/instances/${name}/serialPort?port=1&start=${next}`);
      if (output) {
        log += output.contents ?? '';
        next = output.next ?? next;
      }
    } catch {
      // The port is not readable before the VM runs.
    }
  };
  await waitFor(
    async () => {
      const status = (await instance(zone, name))?.status;
      await read();
      if (log.includes(BAKE_FAILED)) throw new Error(`the image build failed:\n${tail(log)}`);
      return status === 'TERMINATED';
    },
    BAKE_TIMEOUT_MS,
    'image build',
  );
  await read();
  if (!log.includes(BAKE_DONE)) throw new Error(`the builder stopped before the build finished:\n${tail(log)}`);
}

/** Builds an image with Docker, the job's container image, the runner and Node already in place. */
async function bake() {
  const pulls = words('SPOT_PREPULL_IMAGES');
  const nodes = words('SPOT_BAKE_NODE_VERSIONS');
  const [runnerVersion, candidates] = await Promise.all([
    latestRunnerVersion(),
    offers(words('SPOT_BAKE_TYPES', DEFAULT_BUILDER_TYPES).map((type) => ({ type }))),
    ensureNetwork(),
  ]);
  if (candidates.length === 0) throw new Error(`no builder type is offered in ${region()}`);
  const when = stamp();
  const name = `${NAME_PREFIX}bake-${repoSlug()}-${when}`;
  const script = bakeScript({ runnerVersion, images: pulls, nodes });
  const offer = await launch(candidates, (item) =>
    instanceBody({ offer: item, name, image: PUBLIC_IMAGE, script, diskGb: 40, spot: false, maxMinutes: 60 }),
  );
  console.info(`Building on ${offer.zone}/${name} (${offer.type})`);
  try {
    await watchBake(offer.zone, name);
    const imageName = `${family()}-${when}`;
    await done(
      await compute('POST', 'global/images', {
        name: imageName,
        family: family(),
        sourceDisk: `zones/${offer.zone}/disks/${name}`,
        labels: { [LABEL]: repoSlug() },
        description: `runner ${runnerVersion}; node ${nodes.join(' ') || '-'}; ${pulls.join(' ')}`.slice(0, 2048),
      }),
    );
    console.info(`Image ${imageName} is ready`);
    setOutputs({ 'image-id': imageName });
  } finally {
    await destroy(offer.zone, name);
  }
  await pruneImages();
}

/** Keeps the newest images of this repository's family and deletes the rest. */
async function pruneImages() {
  const filter = encodeURIComponent(`family = "${family()}"`);
  const { items = [] } = await compute('GET', `global/images?filter=${filter}`);
  const old = items
    .sort((a, b) => b.creationTimestamp.localeCompare(a.creationTimestamp))
    .slice(Number(setting('SPOT_KEEP_IMAGES', '2')));
  for (const image of old) {
    await done(await compute('DELETE', `global/images/${image.name}`));
    console.info(`Deleted old image ${image.name}`);
  }
}

async function network() {
  await ensureNetwork();
  console.info(`Network ${NETWORK} is ready`);
}

await run({ start, stop, sweep, bake, network }, 'gcp-runner.mjs');
