/**
 * Helpers shared by aliyun-runner.mjs and gcp-runner.mjs: settings, polling,
 * names, the GitHub API and GitHub Actions outputs. tencent-runner.mjs
 * predates them and keeps its own copies.
 */
import { appendFileSync } from 'node:fs';

export const NAME_PREFIX = 'ci-';
export const POLL_MS = 3_000;
export const RUNNER_ONLINE_TIMEOUT_MS = 8 * 60_000;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const setting = (name, fallback) => process.env[name] || fallback;
export const words = (name, fallback = '') => setting(name, fallback).split(/\s+/).filter(Boolean);
export const isoSeconds = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
export const secondsSince = (start) => Math.round((Date.now() - start) / 1000);

export function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** This repository's name, lowercase, safe in machine and image names. */
export function repoSlug() {
  const name = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? 'local';
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40).replace(/-+$/, '');
}

/** A timestamp for image and builder names, such as 20261114-153000. */
export const stamp = () => isoSeconds(new Date()).replace(/[-:]/g, '').replace('T', '-').replace('Z', '');

/** Machine and runner name: ci-<repo>-<run>-<attempt>, lowercase, at most 60 characters. */
export function machineName() {
  const repo = required('GITHUB_REPOSITORY').split('/')[1].toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const suffix = `-${required('GITHUB_RUN_ID')}-${required('GITHUB_RUN_ATTEMPT')}`;
  return `${NAME_PREFIX}${repo.slice(0, 60 - NAME_PREFIX.length - suffix.length).replace(/-+$/, '')}${suffix}`;
}

/** The machine types to try, best first, each with whatever extra fields the caller wants back. */
export function sizes(fallback, example) {
  const list = JSON.parse(setting('SPOT_SIZES', fallback));
  if (!Array.isArray(list) || list.length === 0 || list.some((size) => typeof size?.type !== 'string')) {
    throw new Error(`SPOT_SIZES must be a JSON list like [{"type":"${example}","workers":60}]`);
  }
  return list;
}

export async function waitFor(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(POLL_MS);
  }
  throw new Error(`${what} not ready after ${Math.round(timeoutMs / 60_000)} minutes`);
}

/** Writes step outputs; a no-op outside GitHub Actions. */
export function setOutputs(values) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  appendFileSync(file, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
}

/* ── GitHub API ──────────────────────────────────────────────────────── */

export async function github(path, init = {}) {
  const token = process.env.RUNNER_GITHUB_TOKEN;
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub ${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}

export async function findRunner(repo, name) {
  const { runners } = await github(`/repos/${repo}/actions/runners?per_page=100`);
  return runners.find((runner) => runner.name === name);
}

export const latestRunnerVersion = async () =>
  (await github('/repos/actions/runner/releases/latest')).tag_name.replace(/^v/, '');

export const registrationToken = async (repo) =>
  (await github(`/repos/${repo}/actions/runners/registration-token`, { method: 'POST' })).token;

/** Waits for the runner, logging when the machine itself comes up. */
export async function waitForRunner({ repo, name, boughtAt, isRunning }) {
  let running = false;
  await waitFor(
    async () => {
      if (!running && (await isRunning())) {
        running = true;
        console.info(`Machine running after ${secondsSince(boughtAt)} s`);
      }
      return (await findRunner(repo, name))?.status === 'online';
    },
    RUNNER_ONLINE_TIMEOUT_MS,
    `runner ${name}`,
  );
  console.info(`Runner ${name} is online after ${secondsSince(boughtAt)} s`);
}

/** Removes a runner registration if it is still there. */
export async function removeRunner(repo, name) {
  const runner = await findRunner(repo, name);
  if (!runner) return;
  await github(`/repos/${repo}/actions/runners/${runner.id}`, { method: 'DELETE' });
  console.info(`Removed runner ${runner.name}`);
}

/** Runs the command named on the command line. */
export async function run(commands, script) {
  const command = commands[process.argv[2]];
  if (!command) {
    console.error(`usage: ${script} ${Object.keys(commands).join('|')}`);
    process.exit(2);
  }
  await command().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
