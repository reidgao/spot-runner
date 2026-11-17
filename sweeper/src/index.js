/**
 * The sweeper: a Cloudflare Worker that destroys Tencent Cloud CI machines
 * left behind, on a cron of its own.
 *
 * A Tencent Cloud spot machine cannot destroy itself, so the only things that
 * do are the stop job and the sweep actions, and those are GitHub jobs. When
 * GitHub does not start them (an outage, a billing block, a schedule that
 * runs hours late), this Worker still runs. docs/tencent.md, "A sweep outside
 * GitHub".
 */
import { DEFAULT_MAX_AGE_MINUTES, NAME_PREFIX, cvmClient, sweep } from '../../tencent-cvm.mjs';

/**
 * The cron in wrangler.jsonc runs every ten minutes, so a failure that lasts
 * is told once an hour: by the run in the hour's first ten minutes.
 */
const CRON_MINUTES = 10;

const words = (text) => String(text ?? '').split(/\s+/).filter(Boolean);

export function settings(env) {
  return {
    region: env.TENCENT_REGION || 'ap-hongkong',
    prefixes: words(env.SWEEP_PREFIXES || NAME_PREFIX),
    maxAgeMinutes: Number(env.MAX_AGE_MINUTES || DEFAULT_MAX_AGE_MINUTES),
    dryRun: env.DRY_RUN === '1',
  };
}

/**
 * One push to NOTIFY_URL, when it is set: a POST with the form fields title,
 * body and group, which a Bark server takes as they are. Never throws: a push
 * that fails must not hide what the sweep did.
 */
async function notify(env, send, title, body) {
  if (!env.NOTIFY_URL) return;
  try {
    const response = await send(env.NOTIFY_URL, { method: 'POST', body: new URLSearchParams({ title, body, group: 'ci' }) });
    if (!response.ok) console.warn(`The push was refused: HTTP ${response.status}`);
  } catch (error) {
    console.warn(`The push failed: ${error.message}`);
  }
}

/** One sweep. Returns the machines it destroyed (with DRY_RUN, would destroy). */
export async function run(env, { scheduledTime = Date.now(), send = (...args) => fetch(...args) } = {}) {
  try {
    const { region, prefixes, maxAgeMinutes, dryRun } = settings(env);
    const cvm = cvmClient({ secretId: env.TENCENT_SECRET_ID, secretKey: env.TENCENT_SECRET_KEY, region, send });
    const stale = await sweep(cvm, { prefixes, maxAgeMinutes, dryRun });
    if (stale.length === 0) {
      console.info('No CI machine left behind');
      return stale;
    }
    const list = stale.map((machine) => `${machine.name} (${machine.id}, ${machine.ageMinutes} minutes old)`).join(', ');
    console.warn(`${dryRun ? 'Would destroy' : 'Destroyed'} ${list}`);
    await notify(
      env,
      send,
      dryRun ? 'CI sweeper, dry run' : 'CI sweeper destroyed a machine',
      `${dryRun ? 'Would destroy' : 'Destroyed'} ${list}. No stop job or sweep on GitHub had destroyed it.`,
    );
    return stale;
  } catch (error) {
    console.error(error.message);
    if (new Date(scheduledTime).getUTCMinutes() < CRON_MINUTES) {
      await notify(env, send, 'CI sweeper failed', `${error.message}. Leftover Tencent Cloud CI machines are not being destroyed.`);
    }
    throw error;
  }
}

export default {
  async scheduled(controller, env) {
    await run(env, { scheduledTime: controller.scheduledTime });
  },
};
