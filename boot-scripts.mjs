/**
 * First-boot scripts for the Alibaba Cloud and Google Cloud CI machines
 * (aliyun-runner.mjs, gcp-runner.mjs). Alibaba Cloud runs them as user data,
 * Google Cloud as startup-script metadata; both run them as root. Tencent
 * Cloud's script lives in tencent-runner.mjs.
 *
 * bakeScript builds the image: Docker, the job's container image, the GitHub
 * Actions runner and Node in the runner's tool cache, then powers off.
 * bootScript serves one job. It skips whatever the image already has, so it
 * also works on the public Ubuntu image and on an image that is a little out
 * of date (a newer runner or container image is fetched at boot).
 *
 * Both log to a file and to the console, which Google Cloud keeps as the
 * serial port output: gcp-runner.mjs reads it there to see a bake fail.
 */

const RUNNER_DIR = '/home/ci/actions-runner';
// Outside RUNNER_DIR, so replacing the runner keeps the tool cache.
const WORK_DIR = '/home/ci/work';

export const BAKE_DONE = 'ci-bake: done';
export const BAKE_FAILED = 'ci-bake: failed';

const header = (log) => [
  '#!/bin/bash',
  `exec > >(tee -a ${log}) 2>&1`,
  'set -eu',
  // apt waits for a lock that first-boot updates hold, instead of failing.
  `echo 'DPkg::Lock::Timeout "300";' > /etc/apt/apt.conf.d/90ci-lock-wait`,
  'export DEBIAN_FRONTEND=noninteractive',
];

function installRunner(version) {
  const archive = `actions-runner-linux-x64-${version}.tar.gz`;
  return [
    `rm -rf ${RUNNER_DIR}`,
    `mkdir -p ${RUNNER_DIR}`,
    `cd ${RUNNER_DIR}`,
    `curl -fsSL -o runner.tgz https://github.com/actions/runner/releases/download/v${version}/${archive}`,
    'tar xzf runner.tgz',
    'rm runner.tgz',
    './bin/installdependencies.sh',
    `echo ${version} > .version`,
    'chown -R ci:ci /home/ci',
  ];
}

/** actions/setup-node finds this copy instead of downloading Node again. */
function cacheNode(version) {
  const dir = `${WORK_DIR}/_tool/node/${version}/x64`;
  return [
    `mkdir -p ${dir}`,
    `curl -fsSL https://nodejs.org/dist/v${version}/node-v${version}-linux-x64.tar.gz | tar xz -C ${dir} --strip-components=1`,
    `touch ${dir}.complete`,
  ];
}

export function bakeScript({ runnerVersion, images, nodes }) {
  return [
    ...header('/var/log/ci-bake.log'),
    // Set before tracing starts, so only a real failure prints the marker.
    `trap 'echo "${BAKE_FAILED} at line $LINENO"' ERR`,
    'set -x',
    'apt-get update -y',
    'apt-get install -y docker.io',
    'systemctl enable docker',
    'systemctl start docker',
    ...images.map((image) => `docker pull ${image}`),
    'useradd -m -s /bin/bash ci',
    'usermod -aG docker ci',
    ...installRunner(runnerVersion),
    ...nodes.flatMap(cacheNode),
    'chown -R ci:ci /home/ci',
    'apt-get clean',
    'rm -rf /var/lib/apt/lists/*',
    // A machine started from the image runs its own first-boot script again.
    'cloud-init clean --logs || true',
    'set +x',
    `echo '${BAKE_DONE}'`,
    'sync',
    'poweroff',
    '',
  ].join('\n');
}

export function bootScript({ repo, token, name, runnerVersion, images }) {
  return [
    ...header('/var/log/ci-runner.log'),
    'set -x',
    'if ! command -v docker >/dev/null; then apt-get update -y; apt-get install -y docker.io; fi',
    'systemctl enable --now docker',
    ...images.map((image) => `docker image inspect ${image} >/dev/null 2>&1 || docker pull ${image}`),
    'id ci >/dev/null 2>&1 || useradd -m -s /bin/bash ci',
    'usermod -aG docker ci',
    `if [ "$(cat ${RUNNER_DIR}/.version 2>/dev/null)" != "${runnerVersion}" ]; then`,
    ...installRunner(runnerVersion).map((line) => `  ${line}`),
    'fi',
    `mkdir -p ${WORK_DIR}`,
    `chown ci:ci ${WORK_DIR}`,
    `cd ${RUNNER_DIR}`,
    // Keeps the registration token out of the log and the console.
    'set +x',
    `sudo -u ci ./config.sh --unattended --ephemeral --disableupdate --url https://github.com/${repo} --token ${token} --name ${name} --labels ${name} --work ${WORK_DIR}`,
    'sudo -u ci ./run.sh',
    '',
  ].join('\n');
}
