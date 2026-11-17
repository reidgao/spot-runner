#!/usr/bin/env node
/**
 * Buys, destroys and sweeps the Tencent Cloud spot machines that run GitHub
 * Actions jobs as ephemeral self-hosted runners.
 *
 *   node tencent-runner.mjs start   buy a machine, wait for its runner
 *   node tencent-runner.mjs stop    destroy it, remove its runner
 *   node tencent-runner.mjs sweep   destroy any CI machine left behind
 *
 * Called by the start, stop and sweep actions in this repository, which pass
 * every setting as an environment variable. The Tencent Cloud API client and
 * the sweep itself are in tencent-cvm.mjs, which the sweeper Worker shares.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { DEFAULT_MAX_AGE_MINUTES, NAME_PREFIX, cvmClient, sweep as sweepStale } from './tencent-cvm.mjs';

const X86_FAMILY = /^(SA[2-9]|S[5-9]|C[5-9]|CA[2-9]|M[5-9]|MA[2-9])\./;
const MAX_ATTEMPTS = 8;
const RUNNER_ONLINE_TIMEOUT_MS = 8 * 60_000;
const POLL_MS = 10_000;
const BANDWIDTH_MBPS = 100;
const DEFAULT_SIZES = '[{"cpu":32},{"cpu":16}]';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const setting = (name, fallback) => process.env[name] || fallback;
const region = () => setting('SPOT_REGION', 'ap-hongkong');

/** The sizes to try, biggest first, each with whatever extra fields the caller wants back. */
function sizes() {
  const list = JSON.parse(setting('SPOT_SIZES', DEFAULT_SIZES));
  if (!Array.isArray(list) || list.length === 0 || list.some((size) => !Number.isInteger(size?.cpu))) {
    throw new Error('SPOT_SIZES must be a JSON list like [{"cpu":32,"workers":20}]');
  }
  return list;
}

/* ── Tencent Cloud API ───────────────────────────────────────────────── */

let client;
/** One call to the CVM API with the keys and region from the environment. */
function cvm(action, params) {
  client ??= cvmClient({
    secretId: required('TENCENT_SECRET_ID'),
    secretKey: required('TENCENT_SECRET_KEY'),
    region: region(),
  });
  return client(action, params);
}

/* ── GitHub API ──────────────────────────────────────────────────────── */

async function github(path, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${required('RUNNER_GITHUB_TOKEN')}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub ${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function findRunner(repo, name) {
  const { runners } = await github(`/repos/${repo}/actions/runners?per_page=100`);
  return runners.find((runner) => runner.name === name);
}

async function waitForRunner(repo, name) {
  const deadline = Date.now() + RUNNER_ONLINE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const runner = await findRunner(repo, name);
    if (runner?.status === 'online') return;
    await sleep(POLL_MS);
  }
  throw new Error(`runner ${name} was not online after ${RUNNER_ONLINE_TIMEOUT_MS / 60_000} minutes`);
}

/* ── Choosing and launching a machine ────────────────────────────────── */

async function spotOffers(wanted, maxPerHour) {
  const { InstanceTypeQuotaSet: items } = await cvm('DescribeZoneInstanceConfigInfos', {
    Filters: [{ Name: 'instance-charge-type', Values: ['SPOTPAID'] }],
  });
  return items
    .filter((item) => item.Status === 'SELL' && !item.Gpu && X86_FAMILY.test(item.InstanceType))
    .filter((item) => item.Memory >= item.Cpu * 2)
    .flatMap((item) => {
      const size = wanted.find(({ cpu }) => cpu === item.Cpu);
      if (!size) return [];
      const perHour = item.Price?.UnitPriceDiscount ?? item.Price?.UnitPrice ?? Infinity;
      return [{ zone: item.Zone, type: item.InstanceType, memory: item.Memory, perHour, size, rank: wanted.indexOf(size) }];
    })
    .filter((offer) => offer.perHour <= maxPerHour)
    .sort((a, b) => a.rank - b.rank || a.perHour - b.perHour);
}

async function ubuntuImage() {
  const { ImageSet: images } = await cvm('DescribeImages', {
    Filters: [{ Name: 'image-type', Values: ['PUBLIC_IMAGE'] }],
    Limit: 100,
  });
  const image = images.find(
    (item) => /ubuntu/i.test(item.OsName) && /24\.04/.test(item.OsName) && item.Architecture === 'x86_64',
  );
  if (!image) throw new Error(`no public Ubuntu 24.04 x86_64 image in ${region()}`);
  return image.ImageId;
}

/** Runs once at first boot: close the machine, install Docker, then serve one job. */
function bootScript({ repo, token, name, runnerVersion, images }) {
  const archive = `actions-runner-linux-x64-${runnerVersion}.tar.gz`;
  return [
    '#!/bin/bash',
    'exec > /var/log/ci-runner.log 2>&1',
    'set -eux',
    'iptables -A INPUT -i lo -j ACCEPT',
    'iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
    'iptables -P INPUT DROP',
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -y',
    'apt-get install -y docker.io',
    'systemctl enable --now docker',
    ...images.map((image) => `docker pull ${image}`),
    'useradd -m -s /bin/bash ci',
    'usermod -aG docker ci',
    'cd /home/ci',
    `curl -fsSL -o runner.tgz https://github.com/actions/runner/releases/download/v${runnerVersion}/${archive}`,
    'tar xzf runner.tgz',
    './bin/installdependencies.sh',
    'chown -R ci:ci /home/ci',
    // Keeps the registration token out of the log.
    'set +x',
    `sudo -u ci ./config.sh --unattended --ephemeral --disableupdate --url https://github.com/${repo} --token ${token} --name ${name} --labels ${name}`,
    'sudo -u ci ./run.sh',
    '',
  ].join('\n');
}

function launchRequest({ offer, imageId, name, userData, diskGb }) {
  return {
    InstanceChargeType: 'SPOTPAID',
    Placement: { Zone: offer.zone },
    InstanceType: offer.type,
    ImageId: imageId,
    SystemDisk: { DiskType: 'CLOUD_BSSD', DiskSize: diskGb },
    InternetAccessible: {
      InternetChargeType: 'TRAFFIC_POSTPAID_BY_HOUR',
      InternetMaxBandwidthOut: BANDWIDTH_MBPS,
      PublicIpAssigned: true,
    },
    InstanceCount: 1,
    InstanceName: name,
    // Set explicitly: by default a new password is mailed to the account on
    // every launch. Nobody ever uses this one, and it is not logged.
    LoginSettings: { Password: `Aa1!${randomBytes(12).toString('hex')}` },
    EnhancedService: { SecurityService: { Enabled: false }, MonitorService: { Enabled: false } },
    UserData: Buffer.from(userData, 'utf8').toString('base64'),
  };
}

const isAuthError = (error) => /^(AuthFailure|UnauthorizedOperation)/.test(error.code ?? '');

async function launch(offers, build) {
  const failures = [];
  for (const offer of offers.slice(0, MAX_ATTEMPTS)) {
    try {
      console.info(`Trying ${offer.type} in ${offer.zone} (${offer.size.cpu} vCPU, ¥${offer.perHour}/hour)`);
      const { InstanceIdSet: ids } = await cvm('RunInstances', build(offer));
      return { offer, instanceId: ids[0] };
    } catch (error) {
      if (isAuthError(error)) throw error;
      console.warn(error.message);
      failures.push(error.message);
    }
  }
  throw new Error(`no machine could be bought:\n${failures.join('\n')}`);
}

/* ── Commands ────────────────────────────────────────────────────────── */

function setOutputs(values) {
  const file = required('GITHUB_OUTPUT');
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}\n`);
  appendFileSync(file, lines.join(''));
}

/** Machine and runner name: ci-<repo>-<run>-<attempt>, lowercase, at most 60 characters. */
function machineName() {
  const repo = required('GITHUB_REPOSITORY').split('/')[1].toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const suffix = `-${required('GITHUB_RUN_ID')}-${required('GITHUB_RUN_ATTEMPT')}`;
  return `${NAME_PREFIX}${repo.slice(0, 60 - NAME_PREFIX.length - suffix.length).replace(/-+$/, '')}${suffix}`;
}

async function start() {
  const repo = required('GITHUB_REPOSITORY');
  const name = machineName();
  const maxPerHour = Number(setting('SPOT_MAX_CNY_PER_HOUR', '5'));
  const offers = await spotOffers(sizes(), maxPerHour);
  if (offers.length === 0) throw new Error(`no spot machine of the wanted sizes for sale under ¥${maxPerHour}/hour`);
  console.info(`${offers.length} offers; first choice: ${offers[0].type} in ${offers[0].zone}, ¥${offers[0].perHour}/hour`);

  const [imageId, { token }, { tag_name: tag }] = await Promise.all([
    ubuntuImage(),
    github(`/repos/${repo}/actions/runners/registration-token`, { method: 'POST' }),
    github('/repos/actions/runner/releases/latest'),
  ]);
  const images = setting('SPOT_PREPULL_IMAGES', '').split(/\s+/).filter(Boolean);
  const userData = bootScript({ repo, token, name, runnerVersion: tag.replace(/^v/, ''), images });
  const diskGb = Number(setting('SPOT_DISK_GB', '100'));
  const { offer, instanceId } = await launch(offers, (item) => launchRequest({ offer: item, imageId, name, userData, diskGb }));
  console.info(`Bought ${instanceId}: ${offer.type} in ${offer.zone}, ¥${offer.perHour}/hour`);
  setOutputs({ 'instance-id': instanceId, label: name, size: JSON.stringify(offer.size), 'per-hour': offer.perHour });

  try {
    await waitForRunner(repo, name);
    console.info(`Runner ${name} is online`);
    setOutputs({ ready: 'true' });
  } catch (error) {
    await cvm('TerminateInstances', { InstanceIds: [instanceId] });
    throw error;
  }
}

/** Gone already: start destroyed it after its runner never came online. */
const isGone = (error) => /^(InvalidInstanceId|UnsupportedOperation\.InstanceState)/.test(error.code ?? '');

async function stop() {
  const repo = required('GITHUB_REPOSITORY');
  const instanceId = required('INSTANCE_ID');
  try {
    await cvm('TerminateInstances', { InstanceIds: [instanceId] });
    console.info(`Destroyed ${instanceId}`);
  } catch (error) {
    if (!isGone(error)) throw error;
    console.info(`${instanceId} is already gone: ${error.message}`);
  }
  const runner = await findRunner(repo, required('RUNNER_LABEL'));
  if (runner) {
    await github(`/repos/${repo}/actions/runners/${runner.id}`, { method: 'DELETE' });
    console.info(`Removed runner ${runner.name}`);
  }
}

async function sweep() {
  const prefixes = setting('SPOT_SWEEP_PREFIXES', NAME_PREFIX).split(/\s+/).filter(Boolean);
  const maxAgeMinutes = Number(setting('SPOT_MAX_AGE_MINUTES', String(DEFAULT_MAX_AGE_MINUTES)));
  const stale = await sweepStale(cvm, { prefixes, maxAgeMinutes });
  if (stale.length === 0) {
    console.info('No CI machine left behind');
    return;
  }
  console.info(`Destroyed ${stale.map((machine) => machine.id).join(', ')}`);
}

const commands = { start, stop, sweep };
const command = commands[process.argv[2]];
if (!command) {
  console.error('usage: tencent-runner.mjs start|stop|sweep');
  process.exit(2);
}
await command().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
