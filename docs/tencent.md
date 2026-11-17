# Tencent Cloud

`tencent/start` buys one spot CVM, `tencent/stop` destroys it and `tencent/sweep` destroys leftovers. There is no bake: a machine boots plain Ubuntu and installs Docker, your container image and the runner at boot, which takes about three minutes. Back to the [overview](../README.md).

## What a machine looks like

- **Spot, chosen by vCPU count.** You list vCPU counts; for each one the start action picks the cheapest x86 type with at least 2 GB of memory per vCPU (the SA, S, C, CA, M and MA families) that is for sale, under `max-cny-per-hour`.
- **No inbound traffic.** The machine joins the account's default VPC and security group, so its first-boot script drops every inbound packet (`iptables -P INPUT DROP`) before it installs anything. A public IP carries outbound traffic at up to 100 Mbps, and the login password is random and never stored.
- **Named** `ci-<repository>-<run>-<attempt>`, which the sweep uses.
- **Never destroys itself.** Tencent Cloud refuses a scheduled destroy (`ActionTimer`) on spot instances, and a machine shut down from inside is still billed, so the sweep is the only backstop for a stop job that never ran. Run it on every run and on a schedule (below), and deploy the [sweeper Worker](#a-sweep-outside-github) for the times GitHub runs neither.

## Measured

On 2026-11-10 in Hong Kong, with a Playwright suite of 2,230 tests on `SA9.8XLARGE64` (32 vCPU, 64 GB, about ¥1.3 an hour):

| Workers | Time | CPU busy |
| --- | --- | --- |
| 12 | 241 s | 81% |
| 16 | 218 s | 90% |
| 20 | 208 s | 94% |
| 24 | 208 s | 96% |

So 20. A suite that renders WebGL in software kept the same machine 79% busy with only 4 workers and failed at 6, so measure each suite on its own. Buying took about 9 seconds and the runner was online about 3 minutes later; a whole run took about 10.5 minutes.

## Setup

### 1. A CAM sub-user and its policy

Create a CAM sub-user with programmatic access only and attach this policy. It can create and pay for CVMs, destroy Hong Kong CVMs, and read instances, images, offers and prices; nothing else.

```json
{
  "version": "2.0",
  "statement": [
    { "effect": "allow", "action": ["finance:trade"], "resource": "*" },
    { "effect": "allow", "action": ["name/cvm:RunInstances"], "resource": "*" },
    {
      "effect": "allow",
      "action": ["name/cvm:TerminateInstances"],
      "resource": "*",
      "condition": { "string_equal": { "cvm:region": "ap-hongkong" } }
    },
    {
      "effect": "allow",
      "action": [
        "name/cvm:DescribeInstances",
        "name/cvm:DescribeImages",
        "name/cvm:DescribeZoneInstanceConfigInfos",
        "name/cvm:InquiryPriceRunInstances"
      ],
      "resource": "*"
    }
  ]
}
```

Notes from setting it up:

- A `cvm:region` condition on `RunInstances` is refused, because it does not apply to the VPC, subnet and system-disk resources the call also needs.
- Without `finance:trade` the call fails with "no payment rights".
- Policy changes take about a minute to apply.
- Set a budget alert in the billing console. A policy cannot cap how many machines are bought.
- The account needs a balance, because spot instances freeze some funds while they run.

### 2. Repository secrets

`TENCENT_SECRET_ID`, `TENCENT_SECRET_KEY`, and the GitHub token described in the [overview](../README.md#the-github-token), `RUNNER_REGISTRATION_PAT`.

### 3. Workflows

The [overview's quick start](../README.md#quick-start) with Tencent Cloud's inputs:

```yaml
      - id: spot
        continue-on-error: true
        uses: reidgao/spot-runner/tencent/start@v2.1
        with:
          secret-id: ${{ secrets.TENCENT_SECRET_ID }}
          secret-key: ${{ secrets.TENCENT_SECRET_KEY }}
          github-token: ${{ secrets.RUNNER_REGISTRATION_PAT }}
          sizes: '[{"cpu":32,"workers":20},{"cpu":16,"workers":10}]'
          prepull-images: mcr.microsoft.com/playwright:v1.59.1-noble
```

```yaml
      - uses: reidgao/spot-runner/tencent/stop@v2.1
        with:
          secret-id: ${{ secrets.TENCENT_SECRET_ID }}
          secret-key: ${{ secrets.TENCENT_SECRET_KEY }}
          github-token: ${{ secrets.RUNNER_REGISTRATION_PAT }}
          instance-id: ${{ needs.spot-start.outputs.instance-id }}
          label: ${{ needs.spot-start.outputs.label }}
      - if: ${{ always() }}
        uses: reidgao/spot-runner/tencent/sweep@v2.1
        with:
          secret-id: ${{ secrets.TENCENT_SECRET_ID }}
          secret-key: ${{ secrets.TENCENT_SECRET_KEY }}
```

Keep a scheduled sweep in one repository as well (see the [overview](../README.md#a-sweep-on-a-schedule-too)): a run that never reaches its stop job leaves a machine running, and nothing else would destroy it.

## A sweep outside GitHub

The stop job, its sweep and the scheduled sweep are all GitHub jobs. When GitHub starts none of them after a machine was bought (an outage, a billing block on the account, a schedule that runs hours late), the machine keeps running and keeps being billed. `sweeper/` is a Cloudflare Worker that runs the same sweep every ten minutes on Cloudflare's cron, so a machine left behind lives about 85 minutes at most. It has no public address, stores nothing, and covers every repository that buys machines in the account and region.

### 1. A second sub-user, for the sweeper alone

The Worker needs keys of its own. Give it a CAM sub-user with programmatic access only and this policy, which can list instances and destroy Hong Kong CVMs; it cannot buy anything.

```json
{
  "version": "2.0",
  "statement": [
    { "effect": "allow", "action": ["name/cvm:DescribeInstances"], "resource": "*" },
    {
      "effect": "allow",
      "action": ["name/cvm:TerminateInstances"],
      "resource": "*",
      "condition": { "string_equal": { "cvm:region": "ap-hongkong" } }
    }
  ]
}
```

The policy does not limit which Hong Kong machines the keys can destroy; the Worker destroys only machines whose name starts with a prefix in `SWEEP_PREFIXES` (`ci-`) and that are older than `MAX_AGE_MINUTES` (75). Keep machines with other jobs out of that prefix.

### 2. Deploy

From a checkout of this repository, signed in to wrangler (`npx wrangler login`):

```bash
sweeper/deploy.sh --dry-run
```

It asks for the sub-user's SecretId and SecretKey and, optionally, a push URL, at prompts that echo nothing; they reach Cloudflare as Worker secrets and are stored nowhere else. With `--dry-run` the Worker only logs what it would destroy. Watch a run or two (`npx wrangler tail ci-spot-sweeper`; a healthy run logs `No CI machine left behind`), then turn the dry run off:

```bash
sweeper/deploy.sh
```

Later deploys keep the keys; `sweeper/deploy.sh --rotate` asks for them again. Set `CLOUDFLARE_ACCOUNT_ID` when your login sees more than one account.

### Settings

| Name | Kind | Default | Meaning |
| --- | --- | --- | --- |
| `TENCENT_SECRET_ID`, `TENCENT_SECRET_KEY` | secret | | The sweeper sub-user's keys |
| `NOTIFY_URL` | secret, optional | | Receives a POST with the form fields `title`, `body` and `group` (a [Bark](https://github.com/Finb/Bark) server takes it as it is) when a machine was destroyed, and once an hour while the sweep fails |
| `TENCENT_REGION` | variable | `ap-hongkong` | The region the machines are bought in; the policy above must name the same one |
| `SWEEP_PREFIXES` | variable | `ci-` | Space-separated machine-name prefixes |
| `MAX_AGE_MINUTES` | variable | `75` | Destroy machines older than this |
| `DRY_RUN` | variable | | `1` only logs |

The variables are in `sweeper/wrangler.jsonc`. A push that says a machine was destroyed means no GitHub job had destroyed it: look at why that run's stop job did not run.

## Inputs

| Action | Input | Default | Meaning |
| --- | --- | --- | --- |
| all | `secret-id`, `secret-key` | | The CAM sub-user's keys |
| start, stop | `github-token` | | The registration token's source; see the overview |
| start | `sizes` | `[{"cpu":32},{"cpu":16}]` | vCPU counts to try, best first. Extra fields come back in the `size` output |
| start | `max-cny-per-hour` | `5` | Highest spot price the run may pay |
| start | `prepull-images` | | Docker images to pull at boot |
| start | `region` | `ap-hongkong` | The policy above only lets the sub-user destroy machines in Hong Kong |
| start | `disk-gb` | `100` | System disk size |
| stop | `instance-id`, `label` | | The start action's outputs |
| sweep | `prefixes` | `ci-` | Machine names to sweep |
| sweep | `max-age-minutes` | `75` | Destroy machines older than this |

Start outputs `ready`, `label`, `instance-id`, `size` and `per-hour` (the spot price in CNY).

## Limits

- A spot machine can be reclaimed with two minutes' notice. A reclaimed machine fails its job; rerun it.
- Up to eight offers are tried, best size first and cheapest first within a size; an authorization error stops at the first.

## Running it locally

```bash
TENCENT_SECRET_ID=… TENCENT_SECRET_KEY=… SPOT_REGION=ap-hongkong node tencent-runner.mjs sweep
```

The sweeper Worker runs locally with `npx wrangler dev -c sweeper/wrangler.jsonc --test-scheduled` and the keys in `sweeper/.dev.vars` (ignored by git); a request to `/__scheduled` runs one sweep.
