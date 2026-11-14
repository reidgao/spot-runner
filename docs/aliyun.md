# Alibaba Cloud

`aliyun/start` buys one spot ECS machine, `aliyun/stop` destroys it, `aliyun/sweep` destroys leftovers and `aliyun/bake` builds the image the machines boot from. Back to the [overview](../README.md).

## What a machine looks like

- **Spot, with a cap and a guarantee.** `SpotWithPriceLimit` at `max-cny-per-hour`, and `SpotDuration=1`, so Alibaba Cloud never reclaims the machine in its first hour, longer than any run should take.
- **Releases itself.** `AutoReleaseTime` is 90 minutes after purchase, so a machine whose stop job never ran is gone by then even without a sweep.
- **Its own network.** A VPC named `ci-runner` (`10.88.0.0/16`) with a vSwitch in each zone it buys in, and a security group named `ci-runner` with no inbound rule. They are created on the first purchase and reused after.
- **A public IP for outbound traffic only**, billed by traffic at up to 100 Mbps.
- **Tagged** `ci-runner=<repository>` and named `ci-<repository>-<run>-<attempt>`, which the sweep uses.
- **Boots from this repository's newest baked image** (`ci-runner-<repository>-<date>`), or from the public Ubuntu 24.04 image when there is none yet.

## Measured

On 2026-11-14 in Jakarta (`ap-southeast-5`), with a Playwright suite of 2,574 tests and a WebGL suite of 105:

| Machine | Price per hour | Runner online | Fast suite | WebGL suite | Whole run |
| --- | --- | --- | --- | --- | --- |
| `ecs.g9ae.24xlarge`, 96 physical cores | about ¥11 | 50 s from the baked image, 183 s from plain Ubuntu | 77 s at 60 workers | 35 s at 16 workers | 3.7 to 4.5 min, about ¥0.85 |
| `ecs.g9ae.48xlarge`, 192 physical cores | about ¥33 | about 40 s | 87 s at 120 workers, 4 flaky | 24 s at 32 workers | not worth it |

- The fast suite stopped scaling near 60 workers (81 s at 48 and at 80). Its longest tests, not the CPU, set the time, even though the 96 cores stayed 90 to 99% busy.
- Spot discounts differ by family and zone. On the same day `c9ae` had no discount while `g9ae` (same CPU, more memory) cost 20 to 36% of its list price, and 96 cores in Hong Kong cost twice Jakarta. Read `DescribeSpotPriceHistory` before you choose.
- The `ae` families give one physical core per vCPU. That is why 96 of them beat a bigger hyper-threaded machine at the same price per run.

## Setup

### 1. The account

Pay-as-you-go machines need real-name verification and a balance of at least ¥100. Set a budget alert in the billing console: a policy cannot cap how many machines are bought.

### 2. A RAM user and its policy

Create a RAM user with programmatic access only (an AccessKey, no console login) and attach one custom policy. This one reaches ECS and VPC resources in Jakarta and nothing else; put your own region in both ARNs:

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ecs:*", "vpc:*"],
      "Resource": ["acs:ecs:ap-southeast-5:*:*", "acs:vpc:ap-southeast-5:*:*"]
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecs:DescribeRegions",
        "ecs:DescribeZones",
        "ecs:DescribeAvailableResource",
        "ecs:DescribeSpotPriceHistory",
        "ecs:DescribeInstanceTypes",
        "ecs:DescribeAccountAttributes",
        "ecs:DescribePrice"
      ],
      "Resource": "*"
    }
  ]
}
```

Both ARNs share one statement on purpose. Alibaba Cloud checks an ECS action such as `CreateSecurityGroup` or `RunInstances` against the VPC and vSwitch it touches as well, and with `ecs:*` on ECS resources alone those calls answer `Forbidden.RAM` with no detail. Each API page's authorization table (授权信息) lists every resource an action is checked against.

### 3. Repository secrets

`ALIYUN_ACCESS_KEY_ID`, `ALIYUN_ACCESS_KEY_SECRET`, and the GitHub token described in the [overview](../README.md#the-github-token), `RUNNER_REGISTRATION_PAT`.

### 4. Workflows

The [overview](../README.md#quick-start) has the start, test and stop jobs, the scheduled sweep and the weekly bake, all written for Alibaba Cloud. Bake once by hand (`workflow_dispatch`) before the first run, or the first runs boot from plain Ubuntu and take about three minutes longer.

## Inputs

| Action | Input | Default | Meaning |
| --- | --- | --- | --- |
| all | `access-key-id`, `access-key-secret` | | The RAM user's AccessKey |
| all but sweep | `region` | `ap-southeast-5` | The policy's region |
| start, stop | `github-token` | | The registration token's source; see the overview |
| start | `sizes` | `[{"type":"ecs.g9ae.24xlarge"},{"type":"ecs.g9ae.16xlarge"}]` | Instance types to try, best first. Extra fields come back in the `size` output |
| start | `max-cny-per-hour` | `20` | Offers above it are skipped, and it is sent as the spot price limit |
| start | `prepull-images` | | Docker images the job needs, pulled at boot when the image lacks them |
| start | `disk-gb` | `100` | System disk size |
| start, bake | `image-prefix` | `ci-runner-<repository>-` | Name prefix of this repository's images |
| stop | `instance-id`, `label` | | The start action's outputs |
| sweep | `prefixes` | `ci-` | Machine names to sweep |
| sweep | `max-age-minutes` | `75` | Destroy machines older than this |
| bake | `prepull-images` | | Docker images to bake in |
| bake | `node-versions` | | Node versions for the runner's tool cache, where `actions/setup-node` finds them |
| bake | `builder-types` | `ecs.g9ae.xlarge ecs.g9ae.2xlarge ecs.g9i.xlarge ecs.c9i.xlarge` | Small types to build on, first available wins |
| bake | `keep` | `2` | Images to keep; older ones are deleted with their snapshots, which are billed |

Start outputs `ready`, `label`, `instance-id`, `size` and `per-hour` (the spot price in CNY).

## How an offer is chosen

The start action lists the zones that sell each wanted type as spot, reads each one's latest spot price, drops those above the cap, and tries them best type first and cheapest zone first within a type, up to six times. A sign-in or permission error stops at the first attempt; a stockout moves on to the next offer.

## The bake

A small spot machine boots plain Ubuntu, installs Docker, pulls the given images, installs the runner (in `/home/ci/actions-runner`, with its work directory in `/home/ci/work` so a newer runner swapped in at boot keeps the tool cache) and Node, runs `cloud-init clean` and powers off. The action then creates the image from the stopped machine, destroys the machine and prunes old images. A whole bake took about 12 minutes on 2026-11-14.

## Troubleshooting

- **`Forbidden.RAM`, no detail**: the policy covers ECS resources but not the VPC ones; see the policy above.
- **No offer under the cap**: raise `max-cny-per-hour`, add types to `sizes`, or try another region. Spot capacity for the largest types comes and goes.
- **The runner never comes online**: the first-boot script logs to `/var/log/ci-runner.log` and to the console. The ECS console shows the console output, and so does the `GetInstanceConsoleOutput` API.
- **A balance error on purchase**: top up; pay-as-you-go machines need at least ¥100.

## Running it locally

The script also reads keys from a local `aliyun` CLI profile:

```bash
ALIYUN_PROFILE=my-profile node aliyun-runner.mjs sweep
ALIYUN_PROFILE=my-profile node aliyun-runner.mjs network
```
