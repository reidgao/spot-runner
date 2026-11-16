# spot-runner

Run a GitHub Actions job on a big spot machine that is bought for the run and destroyed after it, on Alibaba Cloud, Google Cloud or Tencent Cloud. The machine registers as an ephemeral self-hosted runner, serves exactly one job, and is gone a few seconds after the job ends.

Each cloud has its own folder of composite actions:

| Action | What it does | Alibaba Cloud | Google Cloud | Tencent Cloud |
| --- | --- | --- | --- | --- |
| `start` | Buy one spot machine, register it as a runner for this repository, wait until it is online | `aliyun/start` | `gcp/start` | `tencent/start` |
| `stop` | Destroy the machine and remove the runner registration | `aliyun/stop` | `gcp/stop` | `tencent/stop` |
| `sweep` | Destroy every CI machine older than 75 minutes, the backstop for a stop job that never ran | `aliyun/sweep` | `gcp/sweep` | `tencent/sweep` |
| `bake` | Build this repository's boot image (Docker, the job's container image, the runner, Node), so a machine is online in about a minute | `aliyun/bake` | `gcp/bake` | none |

The cloud APIs are called with `fetch`, and signed with `node:crypto` where a cloud needs a signature, so no SDK or other third-party package runs next to your keys. Google Cloud needs no stored key at all: it trusts the job's GitHub OIDC token through Workload Identity Federation.

Setup for each cloud: [Alibaba Cloud](docs/aliyun.md), [Google Cloud](docs/gcp.md), [Tencent Cloud](docs/tencent.md).

## When it is worth it

A machine is online about a minute after purchase when it boots from a baked image, and about three minutes after when it boots from plain Ubuntu (Docker, a 2 GB container image and the runner are installed at boot). That pays off when a job takes more than about 8 to 10 minutes on GitHub's 2-core runners, or for heavy one-off runs: a full end-to-end suite, or flake hunting with `--repeat-each`. A job that finishes in a few minutes on GitHub's runners gets slower, not faster.

Use it only from **private** repositories. A self-hosted runner on a public repository can run code from strangers' pull requests.

## Choosing a cloud

| | Alibaba Cloud | Google Cloud | Tencent Cloud |
| --- | --- | --- | --- |
| Sign-in | RAM user's AccessKey, in repository secrets | Workload Identity Federation, no stored key | CAM sub-user's SecretId and SecretKey, in repository secrets |
| You list | Instance types (`ecs.g9ae.24xlarge`) | Machine types (`c4d-highcpu-96`) | vCPU counts; the cheapest x86 type with that count is bought |
| Price cap | `max-cny-per-hour`, also sent as the spot price limit | None needed: spot prices change at most once a month | `max-cny-per-hour` |
| Destroys itself | 90 minutes after purchase, and it is never reclaimed in its first hour | After `max-run-minutes` (default 90), and when reclaimed | No; the sweep is the only backstop |
| Baked image | Yes | Yes | No |
| Default region | `ap-southeast-5` (Jakarta) | `us-central1` (Iowa) | `ap-hongkong` |

Measured with the same Playwright suite (about 2,500 tests):

| Machine | Cores | Price per hour | Runner online | Fast suite | Whole run |
| --- | --- | --- | --- | --- | --- |
| Alibaba `ecs.g9ae.24xlarge` (AMD Turin) | 96 physical | about ¥11 | about 50 s (baked image) | 77 s at 60 workers | about 4.5 min, about ¥0.85 |
| Tencent `SA9.8XLARGE64` (AMD) | 32 vCPU | about ¥1.3 | about 3 min | 208 s at 20 workers | about 10.5 min, about ¥0.25 |
| Google `c4d-highcpu-8` (boot test only) | 8 vCPU | | [see docs/gcp.md](docs/gcp.md#measured) | | |

Physical cores matter more than vCPUs: the Alibaba `ae` families give one physical core per vCPU, while most spot machines give two vCPUs per core. Spot discounts also differ a lot by family and zone, so read the cloud's spot price history before you pick a type.

## Use the machine fully

Spot machines are billed by the second, so size the job to the machine. Measure, do not guess: run your suite at a few worker counts on the machine, record the time and the CPU load, and pick the smallest count after which the time stops falling. Put the result in `sizes`; each entry's extra fields come back in the `size` output for your job to read.

On the Alibaba machine above the fast suite took 81 s at 48 workers, 77 s at 60 and 81 s at 80, so 60. A 192-core machine was slower (87 s at 120 workers, with four flaky timing tests), because every worker shared one preview server and one Playwright runner. A suite that renders WebGL in software kept scaling to 16 workers and stayed clean, so measure each suite on its own.

## Quick start

Three jobs: one buys the machine, one runs on it, one destroys it. The stop job runs whatever happens to the others, and sweeps too. This example uses Alibaba Cloud; the other clouds take the same shape with their own inputs (see their docs).

```yaml
jobs:
  spot-start:
    runs-on: ubuntu-24.04
    timeout-minutes: 12
    outputs:
      ready: ${{ steps.spot.outputs.ready }}
      label: ${{ steps.spot.outputs.label }}
      instance-id: ${{ steps.spot.outputs.instance-id }}
      workers: ${{ steps.spot.outputs.size && fromJSON(steps.spot.outputs.size).workers }}
    steps:
      - id: spot
        # Fall back to GitHub's runners when no machine can be bought.
        continue-on-error: true
        uses: reidgao/spot-runner/aliyun/start@v2.1
        with:
          access-key-id: ${{ secrets.ALIYUN_ACCESS_KEY_ID }}
          access-key-secret: ${{ secrets.ALIYUN_ACCESS_KEY_SECRET }}
          github-token: ${{ secrets.RUNNER_REGISTRATION_PAT }}
          sizes: '[{"type":"ecs.g9ae.24xlarge","workers":60},{"type":"ecs.g9ae.16xlarge","workers":40}]'
          prepull-images: mcr.microsoft.com/playwright:v1.59.1-noble

  test:
    needs: spot-start
    if: ${{ needs.spot-start.outputs.ready == 'true' }}
    runs-on: [self-hosted, '${{ needs.spot-start.outputs.label }}']
    timeout-minutes: 60
    container:
      image: mcr.microsoft.com/playwright:v1.59.1-noble
      options: --ipc=host
    steps:
      - uses: actions/checkout@v5
      - run: npm ci && npx playwright test --workers=${{ needs.spot-start.outputs.workers }}

  spot-stop:
    needs: [spot-start, test]
    if: ${{ always() && needs.spot-start.outputs.instance-id != '' }}
    runs-on: ubuntu-24.04
    steps:
      - uses: reidgao/spot-runner/aliyun/stop@v2.1
        with:
          access-key-id: ${{ secrets.ALIYUN_ACCESS_KEY_ID }}
          access-key-secret: ${{ secrets.ALIYUN_ACCESS_KEY_SECRET }}
          github-token: ${{ secrets.RUNNER_REGISTRATION_PAT }}
          instance-id: ${{ needs.spot-start.outputs.instance-id }}
          label: ${{ needs.spot-start.outputs.label }}
      - if: ${{ always() }}
        uses: reidgao/spot-runner/aliyun/sweep@v2.1
        with:
          access-key-id: ${{ secrets.ALIYUN_ACCESS_KEY_ID }}
          access-key-secret: ${{ secrets.ALIYUN_ACCESS_KEY_SECRET }}

  hosted-test:
    needs: spot-start
    if: ${{ !cancelled() && needs.spot-start.outputs.ready != 'true' }}
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v5
      - run: npm ci && npx playwright test
```

Keep the test job's `timeout-minutes` below the machine's own limit (90 minutes on Alibaba Cloud and Google Cloud), so the job, not the cloud, ends a run that hangs.

### Several clouds, one after another

Give each cloud's start step `continue-on-error: true`, and run the next one only when the one before is not ready:

```yaml
      - id: aliyun
        continue-on-error: true
        uses: reidgao/spot-runner/aliyun/start@v2.1
        with: { ... }
      - id: tencent
        if: ${{ steps.aliyun.outputs.ready != 'true' }}
        continue-on-error: true
        uses: reidgao/spot-runner/tencent/start@v2.1
        with: { ... }
```

Expose one label to the test job (`label: ${{ steps.aliyun.outputs.label || steps.tencent.outputs.label }}`), and in the stop job run each cloud's stop only when that cloud bought something (`if: ${{ always() && needs.spot-start.outputs.aliyun-instance-id != '' }}`).

### A sweep on a schedule too

The stop job sweeps on every run. A schedule in one repository is a second layer, for runs that never reached their stop job; GitHub can start scheduled workflows hours late, so it cannot be the only one. Put it off the hour and half hour, where GitHub is busiest:

```yaml
on:
  schedule:
    - cron: '17,47 * * * *'
  workflow_dispatch:

jobs:
  sweep:
    runs-on: ubuntu-24.04
    steps:
      - uses: reidgao/spot-runner/aliyun/sweep@v2.1
        with:
          access-key-id: ${{ secrets.ALIYUN_ACCESS_KEY_ID }}
          access-key-secret: ${{ secrets.ALIYUN_ACCESS_KEY_SECRET }}
```

One sweep covers every repository that uses the tool in that account and region (on Google Cloud, in that project).

### A baked image

On Alibaba Cloud and Google Cloud a weekly bake keeps the boot image current. A machine fetches whatever is newer than its image at boot (a newer runner, a container image the image lacks), so an image that is a little behind still works, only slower. Bake again when the job's container image or Node version changes:

```yaml
on:
  schedule:
    - cron: '41 4 * * 1'
  workflow_dispatch:

jobs:
  bake:
    runs-on: ubuntu-24.04
    # Alibaba Cloud can take most of an hour to create an image.
    timeout-minutes: 90
    steps:
      - uses: reidgao/spot-runner/aliyun/bake@v2.1
        with:
          access-key-id: ${{ secrets.ALIYUN_ACCESS_KEY_ID }}
          access-key-secret: ${{ secrets.ALIYUN_ACCESS_KEY_SECRET }}
          prepull-images: mcr.microsoft.com/playwright:v1.59.1-noble
          node-versions: '22.23.4'
```

Each repository bakes, boots from and prunes only its own images, and the two newest are kept. On Alibaba Cloud they are named `<prefix><timestamp>` (prefix `ci-runner-<repository>-` unless `image-prefix` sets one), and an image counts only when the timestamp follows the prefix directly, so `unisong` leaves `unisong-website`'s images alone. On Google Cloud each repository has its own image family, `ci-runner-<repository>`.

## The GitHub token

Every cloud needs a fine-grained GitHub token with **Administration: Read and write** on the repositories that use the runner, stored as a repository secret (the examples call it `RUNNER_REGISTRATION_PAT`). It is used only to get a runner registration token at start and to remove the runner at stop. A fine-grained token belongs to one user or one organization, so repositories under different owners need one token each.

To set one secret in several repositories with a single paste (nothing is echoed):

```bash
read -rs VALUE && for repo in owner/repo-a owner/repo-b; do printf %s "$VALUE" | gh secret set RUNNER_REGISTRATION_PAT --repo "$repo"; done; unset VALUE
```

## Security

- **Nothing reaches in.** The Alibaba and Google machines sit in a network of their own with no inbound rule: a security group without one, a VPC without firewall rules. The Tencent machines join the account's default network, so their first-boot script drops every inbound packet before it does anything else. A machine only talks out, to GitHub and the package mirrors.
- **The machine holds no cloud credentials.** No RAM role, service account or CAM role is attached, so a job cannot reach your cloud account.
- **The registration token is visible on the machine.** It travels in the first-boot script, which any process on the machine can read from the cloud's metadata service, and it lets whoever holds it register another runner to the repository for an hour. One more reason to run only trusted code, on private repositories. The token never appears in a log or on the console.
- **Least privilege.** Each cloud's doc gives a policy that reaches only what the scripts call, in one region where the cloud allows it. A policy cannot cap how many machines are bought, so set a budget alert in each cloud's billing console.

## Running the scripts yourself

Every action is a thin wrapper around one script per cloud (`aliyun-runner.mjs`, `gcp-runner.mjs`, `tencent-runner.mjs`) that reads its settings from environment variables, so a local test or a manual cleanup is one command:

```bash
GCP_ACCESS_TOKEN="$(gcloud auth print-access-token)" GCP_PROJECT=my-ci-project node gcp-runner.mjs sweep
```

`start` also needs `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT` and `RUNNER_GITHUB_TOKEN`; each action file lists the variables it sets. The scripts need Node 20 or later and nothing else. `node --test` runs the tests.

| File | Holds |
| --- | --- |
| `aliyun-runner.mjs`, `gcp-runner.mjs`, `tencent-runner.mjs` | Each cloud's API calls and the start, stop, sweep and bake commands |
| `common.mjs` | Settings, polling, names, outputs and the GitHub API, shared by the Alibaba and Google scripts |
| `common.test.mjs` | Tests for `common.mjs` |
| `boot-scripts.mjs` | The first-boot scripts for Alibaba and Google: the bake, and the boot that serves one job |

## Versions

- `@v2.1`: the layout above, a folder per cloud. On Alibaba Cloud an image belongs to a repository only when the timestamp follows its prefix directly.
- `@v2`: the same layout, but on Alibaba Cloud every image whose name began with the repository's prefix counted as its own. A repository whose name begins another's, such as `unisong` and `unisong-website`, booted from whichever repository's image was newest, and its bake kept only the two newest images of both, deleting the other's. Move such a repository to `@v2.1`, or give it an `image-prefix` that begins no other repository's images.
- `@v1`: the original Tencent Cloud actions at the repository root (`start`, `stop`, `sweep`), from when this repository was called `tencent-spot-runner`. They still work, and GitHub redirects the old repository name, but new workflows should use `@v2.1`.

`main` may move ahead of the newest tag. Pin a tag, or a commit for full control.

## Limits

- A reclaimed spot machine fails its job; rerun it. Alibaba Cloud never reclaims a machine in its first hour (`SpotDuration=1`). Google Cloud and Tencent Cloud can reclaim one at any time, with 30 seconds' and two minutes' notice.
- Linux x86 machines with Ubuntu 24.04 only.
- One job per machine. To run a matrix on one machine, run its parts in parallel inside a single job.
