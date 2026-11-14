#!/usr/bin/env node
/**
 * Buys, destroys and sweeps the Alibaba Cloud spot machines that run GitHub
 * Actions jobs as ephemeral self-hosted runners, and bakes the image they
 * boot from.
 *
 *   node aliyun-runner.mjs start    buy a machine, wait for its runner
 *   node aliyun-runner.mjs stop     destroy it, remove its runner
 *   node aliyun-runner.mjs sweep    destroy any CI machine left behind
 *   node aliyun-runner.mjs bake     build a fresh boot image for this repository
 *   node aliyun-runner.mjs network  create the VPC, vSwitches and security group
 *
 * Called by the aliyun/* actions in this repository, which pass every setting
 * as an environment variable. Keys come from ALIYUN_ACCESS_KEY_ID and
 * ALIYUN_ACCESS_KEY_SECRET, or locally from an aliyun CLI profile named by
 * ALIYUN_PROFILE. The API is signed with node:crypto (ACS3-HMAC-SHA256) and
 * called with fetch, so no third-party package runs next to the keys.
 * docs/aliyun.md has the RAM policy and the setup.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { bakeScript, bootScript } from './boot-scripts.mjs';
import {
  NAME_PREFIX,
  isoSeconds,
  latestRunnerVersion,
  machineName,
  registrationToken,
  removeRunner,
  repoSlug,
  withRetry,
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

const VERSIONS = { ecs: '2014-05-26', vpc: '2016-04-28' };
const TAG_KEY = 'ci-runner';
const NETWORK_NAME = 'ci-runner';
const VPC_CIDR = '10.88.0.0/16';
const PUBLIC_IMAGE = 'ubuntu_24_04_x64_20G_alibase_*';
const DEFAULT_SIZES = '[{"type":"ecs.g9ae.24xlarge"},{"type":"ecs.g9ae.16xlarge"}]';
const DEFAULT_BUILDER_TYPES = 'ecs.g9ae.xlarge ecs.g9ae.2xlarge ecs.g9i.xlarge ecs.c9i.xlarge';
const MAX_ATTEMPTS = 6;
const BANDWIDTH_MBPS = 100;
const BAKE_TIMEOUT_MS = 30 * 60_000;
const IMAGE_TIMEOUT_MS = 45 * 60_000;
const AUTO_RELEASE_MINUTES = 90;

const region = () => setting('ALIYUN_REGION', 'ap-southeast-5');
/** Each repository bakes, boots from and prunes only its own images. */
const imagePrefix = () => setting('SPOT_IMAGE_PREFIX', `ci-runner-${repoSlug()}-`);

/** Keys from the environment, or from a local aliyun CLI profile. */
function credentials() {
  const profile = process.env.ALIYUN_PROFILE;
  if (!profile) return { id: required('ALIYUN_ACCESS_KEY_ID'), secret: required('ALIYUN_ACCESS_KEY_SECRET') };
  const config = JSON.parse(readFileSync(join(homedir(), '.aliyun', 'config.json'), 'utf8'));
  const entry = config.profiles?.find((item) => item.name === profile);
  if (!entry?.access_key_id) throw new Error(`aliyun profile ${profile} has no access key`);
  return { id: entry.access_key_id, secret: entry.access_key_secret };
}

/* ── Alibaba Cloud API (ACS3-HMAC-SHA256) ────────────────────────────── */

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const encode = (text) =>
  encodeURIComponent(text).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

async function call(product, action, params = {}) {
  const host = `${product}.${region()}.aliyuncs.com`;
  return withRetry(() => send(host, product, action, params), host);
}

/** Signs and sends one request; a fresh date and nonce each time, so a retry is a new request. */
async function send(host, product, action, params) {
  const { id, secret } = credentials();
  const query = Object.entries({ RegionId: region(), ...params })
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [encode(key), encode(String(value))])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const headers = {
    host,
    'x-acs-action': action,
    'x-acs-content-sha256': sha256(''),
    'x-acs-date': isoSeconds(new Date()),
    'x-acs-signature-nonce': randomBytes(16).toString('hex'),
    'x-acs-version': VERSIONS[product],
  };
  const names = Object.keys(headers).sort();
  const canonical = ['POST', '/', query, names.map((name) => `${name}:${headers[name]}\n`).join(''), names.join(';'), sha256('')];
  const signature = createHmac('sha256', secret)
    .update(`ACS3-HMAC-SHA256\n${sha256(canonical.join('\n'))}`, 'utf8')
    .digest('hex');
  const response = await fetch(`https://${host}/?${query}`, {
    method: 'POST',
    headers: {
      ...headers,
      Accept: 'application/json',
      Authorization: `ACS3-HMAC-SHA256 Credential=${id},SignedHeaders=${names.join(';')},Signature=${signature}`,
    },
  });
  const body = await response.json();
  if (!response.ok || body.Code) {
    throw Object.assign(new Error(`${action}: ${body.Code}: ${body.Message}`), { code: body.Code ?? '' });
  }
  return body;
}

const ecs = (action, params) => call('ecs', action, params);
const vpc = (action, params) => call('vpc', action, params);

/* ── Network: one VPC, a vSwitch per zone, a security group with no inbound rules ── */

async function ensureVpc() {
  const found = (await vpc('DescribeVpcs', { VpcName: NETWORK_NAME })).Vpcs.Vpc[0];
  if (found) return found.VpcId;
  const { VpcId } = await vpc('CreateVpc', { VpcName: NETWORK_NAME, CidrBlock: VPC_CIDR, Description: 'CI spot runners' });
  await waitFor(async () => (await vpc('DescribeVpcs', { VpcId })).Vpcs.Vpc[0]?.Status === 'Available', 120_000, 'VPC');
  console.info(`Created VPC ${VpcId}`);
  return VpcId;
}

async function ensureVSwitches(vpcId, zones) {
  const existing = (await vpc('DescribeVSwitches', { VpcId: vpcId, PageSize: 50 })).VSwitches.VSwitch;
  const byZone = new Map(existing.map((item) => [item.ZoneId, item.VSwitchId]));
  const used = new Set(existing.map((item) => item.CidrBlock));
  for (const zone of zones.filter((item) => !byZone.has(item))) {
    const block = [...Array(250).keys()].map((n) => `10.88.${n + 1}.0/24`).find((cidr) => !used.has(cidr));
    const { VSwitchId } = await vpc('CreateVSwitch', {
      VpcId: vpcId,
      ZoneId: zone,
      CidrBlock: block,
      VSwitchName: `${NETWORK_NAME}-${zone}`,
    });
    await waitFor(
      async () => (await vpc('DescribeVSwitches', { VSwitchId })).VSwitches.VSwitch[0]?.Status === 'Available',
      120_000,
      'vSwitch',
    );
    used.add(block);
    byZone.set(zone, VSwitchId);
    console.info(`Created vSwitch ${VSwitchId} in ${zone}`);
  }
  return byZone;
}

async function ensureSecurityGroup(vpcId) {
  const found = (await ecs('DescribeSecurityGroups', { VpcId: vpcId, SecurityGroupName: NETWORK_NAME })).SecurityGroups
    .SecurityGroup[0];
  if (found) return found.SecurityGroupId;
  const { SecurityGroupId } = await ecs('CreateSecurityGroup', {
    VpcId: vpcId,
    SecurityGroupName: NETWORK_NAME,
    Description: 'CI spot runners: no inbound, all outbound',
  });
  await ecs('AuthorizeSecurityGroupEgress', {
    SecurityGroupId,
    IpProtocol: 'all',
    PortRange: '-1/-1',
    DestCidrIp: '0.0.0.0/0',
  });
  console.info(`Created security group ${SecurityGroupId}`);
  return SecurityGroupId;
}

/** One after another, so a refused call never leaves the other half-made. */
async function ensureNetwork(zones) {
  const vpcId = await ensureVpc();
  const groupId = await ensureSecurityGroup(vpcId);
  const vswitches = await ensureVSwitches(vpcId, zones);
  return { vswitches, groupId };
}

/* ── Choosing and launching a machine ────────────────────────────────── */

/** Zones that sell each wanted type as spot, in order of preference, cheapest zone first. */
async function spotOffers(wanted, maxPerHour) {
  const zones = (
    await ecs('DescribeAvailableResource', {
      DestinationResource: 'InstanceType',
      InstanceChargeType: 'PostPaid',
      SpotStrategy: 'SpotAsPriceGo',
    })
  ).AvailableZones.AvailableZone;
  const offers = zones.flatMap((zone) =>
    (zone.AvailableResources?.AvailableResource ?? []).flatMap((resource) =>
      (resource.SupportedResources?.SupportedResource ?? [])
        .filter((item) => item.Status === 'Available')
        .flatMap((item) => {
          const size = wanted.find(({ type }) => type === item.Value);
          return size ? [{ zone: zone.ZoneId, type: item.Value, size, rank: wanted.indexOf(size) }] : [];
        }),
    ),
  );
  const priced = await Promise.all(offers.map(async (offer) => ({ ...offer, perHour: await spotPrice(offer) })));
  return priced
    .filter((offer) => offer.perHour <= maxPerHour)
    .sort((a, b) => a.rank - b.rank || a.perHour - b.perHour);
}

async function spotPrice({ zone, type }) {
  const end = new Date();
  const { SpotPrices } = await ecs('DescribeSpotPriceHistory', {
    ZoneId: zone,
    InstanceType: type,
    NetworkType: 'vpc',
    OSType: 'linux',
    StartTime: isoSeconds(new Date(end.getTime() - 6 * 3_600_000)),
    EndTime: isoSeconds(end),
  });
  const points = SpotPrices.SpotPriceType.sort((a, b) => a.Timestamp.localeCompare(b.Timestamp));
  return points.at(-1)?.SpotPrice ?? Infinity;
}

/** The newest baked image, or the public Ubuntu 24.04 image when none is ready. */
async function bootImage() {
  const own = await images();
  if (own[0]) return { imageId: own[0].ImageId, baked: true, label: own[0].ImageName };
  return publicImage();
}

async function publicImage() {
  const { Images } = await ecs('DescribeImages', {
    ImageOwnerAlias: 'system',
    OSType: 'linux',
    Architecture: 'x86_64',
    ImageName: PUBLIC_IMAGE,
    PageSize: 20,
  });
  const image = Images.Image.sort((a, b) => b.CreationTime.localeCompare(a.CreationTime))[0];
  if (!image) throw new Error(`no public Ubuntu 24.04 image in ${region()}`);
  return { imageId: image.ImageId, baked: false, label: image.ImageName };
}

/** This repository's baked images, newest first. */
async function images(status = 'Available') {
  const { Images } = await ecs('DescribeImages', { ImageOwnerAlias: 'self', Status: status, PageSize: 100 });
  return Images.Image.filter((image) => image.ImageName.startsWith(imagePrefix())).sort((a, b) =>
    b.CreationTime.localeCompare(a.CreationTime),
  );
}

function launchRequest({ offer, imageId, network, name, userData, diskGb, maxPerHour, repo }) {
  return {
    ZoneId: offer.zone,
    InstanceType: offer.type,
    ImageId: imageId,
    VSwitchId: network.vswitches.get(offer.zone),
    SecurityGroupId: network.groupId,
    InstanceName: name,
    HostName: name,
    InstanceChargeType: 'PostPaid',
    SpotStrategy: 'SpotWithPriceLimit',
    SpotPriceLimit: maxPerHour,
    // No reclaim in the first hour, longer than any job.
    SpotDuration: 1,
    SpotInterruptionBehavior: 'Terminate',
    // The machine releases itself even if the stop job never runs.
    AutoReleaseTime: isoSeconds(new Date(Date.now() + AUTO_RELEASE_MINUTES * 60_000)),
    InternetChargeType: 'PayByTraffic',
    InternetMaxBandwidthOut: BANDWIDTH_MBPS,
    'SystemDisk.Category': 'cloud_essd',
    'SystemDisk.Size': diskGb,
    UserData: Buffer.from(userData, 'utf8').toString('base64'),
    'Tag.1.Key': TAG_KEY,
    'Tag.1.Value': repo,
    Amount: 1,
    MinAmount: 1,
    DryRun: process.env.SPOT_DRY_RUN === '1' ? 'true' : undefined,
  };
}

const isAuthError = (error) => /^(Forbidden|InvalidAccessKeyId|SignatureDoesNotMatch|IncompleteSignature)/.test(error.code);

async function launch(offers, build) {
  const failures = [];
  for (const offer of offers.slice(0, MAX_ATTEMPTS)) {
    try {
      console.info(`Trying ${offer.type} in ${offer.zone} (¥${offer.perHour}/hour)`);
      // The token makes a repeated request (after a lost answer) buy nothing more.
      const token = `${offer.zone}-${offer.type}-${randomBytes(8).toString('hex')}`;
      const { InstanceIdSets } = await ecs('RunInstances', { ...build(offer), ClientToken: token });
      return { offer, instanceId: InstanceIdSets.InstanceIdSet[0] };
    } catch (error) {
      if (error.code === 'DryRunOperation') return { offer, instanceId: '' };
      if (isAuthError(error)) throw error;
      console.warn(error.message);
      failures.push(error.message);
    }
  }
  throw new Error(`no machine could be bought:\n${failures.join('\n')}`);
}

async function instance(instanceId) {
  const { Instances } = await ecs('DescribeInstances', { InstanceIds: JSON.stringify([instanceId]) });
  return Instances.Instance[0];
}

async function destroy(instanceIds) {
  if (instanceIds.length === 0) return;
  await ecs('DeleteInstances', {
    Force: true,
    ...Object.fromEntries(instanceIds.map((id, index) => [`InstanceId.${index + 1}`, id])),
  });
}

/* ── Commands ────────────────────────────────────────────────────────── */

async function start() {
  const repo = required('GITHUB_REPOSITORY');
  const name = machineName();
  const maxPerHour = Number(setting('SPOT_MAX_CNY_PER_HOUR', '20'));
  const offers = await spotOffers(sizes(DEFAULT_SIZES, 'ecs.g9ae.24xlarge'), maxPerHour);
  if (offers.length === 0) throw new Error(`no spot machine of the wanted types for sale under ¥${maxPerHour}/hour`);
  console.info(`${offers.length} offers; first choice: ${offers[0].type} in ${offers[0].zone}, ¥${offers[0].perHour}/hour`);

  const dryRun = process.env.SPOT_DRY_RUN === '1';
  const [network, image, token, runnerVersion] = await Promise.all([
    ensureNetwork([...new Set(offers.map((offer) => offer.zone))]),
    bootImage(),
    dryRun ? 'dry-run' : registrationToken(repo),
    latestRunnerVersion(),
  ]);
  console.info(`Booting from ${image.baked ? 'baked image' : 'public image'} ${image.label}`);
  const userData = bootScript({ repo, token, name, runnerVersion, images: words('SPOT_PREPULL_IMAGES') });
  const diskGb = Number(setting('SPOT_DISK_GB', '100'));
  const boughtAt = Date.now();
  const { offer, instanceId } = await launch(offers, (item) =>
    launchRequest({ offer: item, imageId: image.imageId, network, name, userData, diskGb, maxPerHour, repo }),
  );
  if (dryRun) {
    console.info(`Dry run passed for ${offer.type} in ${offer.zone}`);
    return;
  }
  console.info(`Bought ${instanceId}: ${offer.type} in ${offer.zone}, ¥${offer.perHour}/hour`);
  setOutputs({ 'instance-id': instanceId, label: name, size: JSON.stringify(offer.size), 'per-hour': offer.perHour });

  try {
    await waitForRunner({ repo, name, boughtAt, isRunning: async () => (await instance(instanceId))?.Status === 'Running' });
    setOutputs({ ready: 'true' });
  } catch (error) {
    await destroy([instanceId]);
    throw error;
  }
}

async function stop() {
  const repo = required('GITHUB_REPOSITORY');
  const instanceId = required('INSTANCE_ID');
  try {
    await destroy([instanceId]);
    console.info(`Destroyed ${instanceId}`);
  } catch (error) {
    if (!/NotFound|InvalidInstanceId/.test(error.code)) throw error;
    console.info(`${instanceId} is already gone: ${error.message}`);
  }
  await removeRunner(repo, required('RUNNER_LABEL'));
}

async function sweep() {
  const maxAgeMs = Number(setting('SPOT_MAX_AGE_MINUTES', '75')) * 60_000;
  const prefixes = words('SPOT_SWEEP_PREFIXES', NAME_PREFIX);
  const { Instances } = await ecs('DescribeInstances', { PageSize: 100 });
  const stale = Instances.Instance.filter(
    (item) =>
      prefixes.some((prefix) => item.InstanceName.startsWith(prefix)) && Date.now() - Date.parse(item.CreationTime) > maxAgeMs,
  );
  if (stale.length === 0) {
    console.info('No CI machine left behind');
    return;
  }
  const ids = stale.map((item) => item.InstanceId);
  await destroy(ids);
  console.info(`Destroyed ${ids.join(', ')}`);
}

/** Builds an image with Docker, the job's container image, the runner and Node already in place. */
async function bake() {
  const pulls = words('SPOT_PREPULL_IMAGES');
  const nodes = words('SPOT_BAKE_NODE_VERSIONS');
  const runnerVersion = await latestRunnerVersion();
  const offers = await spotOffers(words('SPOT_BAKE_TYPES', DEFAULT_BUILDER_TYPES).map((type) => ({ type })), 5);
  if (offers.length === 0) throw new Error('no small spot machine for sale to build the image on');
  const [network, { imageId: base }] = await Promise.all([
    ensureNetwork([...new Set(offers.map((item) => item.zone))]),
    publicImage(),
  ]);
  const when = stamp();
  const name = `${NAME_PREFIX}bake-${repoSlug()}-${when}`;
  const userData = bakeScript({ runnerVersion, images: pulls, nodes });
  const { offer, instanceId } = await launch(offers, (item) =>
    launchRequest({ offer: item, imageId: base, network, name, userData, diskGb: 40, maxPerHour: 5, repo: 'image-builder' }),
  );
  console.info(`Building on ${instanceId} (${offer.type} in ${offer.zone})`);
  try {
    await waitFor(async () => (await instance(instanceId))?.Status === 'Stopped', BAKE_TIMEOUT_MS, 'image build');
    const description = `runner ${runnerVersion}; node ${nodes.join(' ') || '-'}; ${pulls.join(' ')}`.slice(0, 256);
    const { ImageId } = await ecs('CreateImage', { InstanceId: instanceId, ImageName: `${imagePrefix()}${when}`, Description: description });
    console.info(`Creating image ${ImageId}`);
    await waitFor(
      async () => (await images('Creating,Waiting,Available')).find((image) => image.ImageId === ImageId)?.Status === 'Available',
      IMAGE_TIMEOUT_MS,
      `image ${ImageId}`,
    );
    console.info(`Image ${ImageId} is ready`);
    setOutputs({ 'image-id': ImageId });
  } finally {
    await destroy([instanceId]);
  }
  await pruneImages();
}

/** Keeps the newest images and deletes the rest with their snapshots, which are billed. */
async function pruneImages() {
  const old = (await images()).slice(Number(setting('SPOT_KEEP_IMAGES', '2')));
  for (const image of old) {
    await ecs('DeleteImage', { ImageId: image.ImageId, Force: true });
    for (const mapping of image.DiskDeviceMappings?.DiskDeviceMapping ?? []) {
      if (mapping.SnapshotId) await ecs('DeleteSnapshot', { SnapshotId: mapping.SnapshotId, Force: true });
    }
    console.info(`Deleted old image ${image.ImageName}`);
  }
}

async function network() {
  const offers = await spotOffers(sizes(DEFAULT_SIZES, 'ecs.g9ae.24xlarge'), Number(setting('SPOT_MAX_CNY_PER_HOUR', '20')));
  const { vswitches, groupId } = await ensureNetwork([...new Set(offers.map((offer) => offer.zone))]);
  console.info(`Security group ${groupId}; vSwitches ${[...vswitches].map(([zone, id]) => `${zone}=${id}`).join(', ')}`);
}

await run({ start, stop, sweep, bake, network }, 'aliyun-runner.mjs');
