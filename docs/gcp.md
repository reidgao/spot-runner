# Google Cloud

`gcp/start` buys one spot VM, `gcp/stop` deletes it, `gcp/sweep` deletes leftovers and `gcp/bake` builds the image the VMs boot from. Back to the [overview](../README.md).

## What a VM looks like

- **Spot, and it deletes itself.** `provisioningModel: SPOT` with `instanceTerminationAction: DELETE`: Google Cloud deletes the VM when it reclaims it, and after `max-run-minutes` (default 90) even if the stop job never runs.
- **No stored key.** In GitHub Actions the scripts trade the job's OIDC token for a Google token through Workload Identity Federation, and for a service account's token when you name one.
- **Its own network.** A VPC named `ci-runner` with automatic subnets and no firewall rule, so Google Cloud's implied rules let traffic out and nothing in.
- **No credentials on the VM.** No service account is attached, so a job cannot reach your project.
- **An ephemeral external IP** for outbound traffic.
- **The right disk and network card for the type.** Third- and fourth-generation series (C4, C4D, N4 and the like) boot from Hyperdisk Balanced with a gVNIC card; older ones from a balanced persistent disk.
- **Labelled** `ci-runner=<repository>` and named `ci-<repository>-<run>-<attempt>`. The sweep deletes only VMs that carry the label.
- **Boots from this repository's baked image family** (`ci-runner-<repository>`), or from the public Ubuntu 24.04 family when there is none yet.

## Measured

On 2026-11-14 in `us-central1`, from a workstation with a gcloud token:

| Step | Time |
| --- | --- |
| Buy a `c4d-highcpu-8` spot VM (request to running) | 11 to 14 s |
| Runner online, from plain Ubuntu (Docker, a 2 GB container image, the runner) | 188 s |
| Bake an image on a `c4d-highcpu-4` (build, stop, create the image) | about 4 min |
| Runner online, from the baked image | 50 s |

The baked image (Docker, the Playwright container image, the runner and Node) took 3.8 GB in the `us` multi-region. No full test suite has run on Google Cloud yet, so measure your worker counts on your own machine type.

## Setup

### 1. A project and its quota

Use a project of its own for CI: the identity the workflow acts as can create and delete any VM in its project.

Spot VMs count against the region's **Preemptible CPUs** quota when the project has one, and against the regular **CPUs** quota when it does not; either way also against the machine family's quota (such as **C4D CPUs**) and **CPUs (all regions)**. New projects start low, for example 24 C4D CPUs per region, so request what your largest type needs under IAM & Admin, Quotas. Google may refuse a large request on a new billing account; it can be asked again once the account has some history.

Set a budget alert in the billing console: no permission can cap how many VMs are bought.

### 2. Workload Identity Federation

Run these once, with your project and repository:

```bash
PROJECT=my-ci-project
OWNER=my-github-user-or-org
REPO=$OWNER/my-repo
NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')

gcloud services enable compute.googleapis.com iamcredentials.googleapis.com sts.googleapis.com --project $PROJECT

# Trust GitHub's OIDC tokens, but only for repositories of this owner.
gcloud iam workload-identity-pools create github --project $PROJECT --location global --display-name GitHub
gcloud iam workload-identity-pools providers create-oidc github --project $PROJECT --location global \
  --workload-identity-pool github \
  --issuer-uri https://token.actions.githubusercontent.com \
  --attribute-mapping 'google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner' \
  --attribute-condition "assertion.repository_owner == '$OWNER'"

# A service account that may run VMs, which the repository may act as.
gcloud iam service-accounts create ci-runner --project $PROJECT --display-name 'CI spot runners'
gcloud projects add-iam-policy-binding $PROJECT \
  --member serviceAccount:ci-runner@$PROJECT.iam.gserviceaccount.com \
  --role roles/compute.instanceAdmin.v1
gcloud iam service-accounts add-iam-policy-binding ci-runner@$PROJECT.iam.gserviceaccount.com --project $PROJECT \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/$NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$REPO"

# The network, once (the role above can use it but not create it).
gcloud compute networks create ci-runner --project $PROJECT --subnet-mode auto

echo "workload-identity-provider: projects/$NUMBER/locations/global/workloadIdentityPools/github/providers/github"
echo "service-account: ci-runner@$PROJECT.iam.gserviceaccount.com"
```

To let another repository use it, add one more `roles/iam.workloadIdentityUser` binding with that repository's name.

`roles/compute.instanceAdmin.v1` covers every call the scripts make (VMs, disks, images, the serial port, operations) except creating the network, hence the one-time `networks create`. If you would rather not create a service account, grant that role to the `principalSet://…` member on the project directly and leave `service-account` empty: the scripts then use the federated token as it is.

Neither value is a secret, so they can sit in the workflow or in repository variables.

### 3. Workflows

Every job that calls a `gcp/*` action needs an OIDC token:

```yaml
permissions:
  contents: read
  id-token: write
```

The start and stop steps of the [overview's quick start](../README.md#quick-start) become:

```yaml
      - id: spot
        continue-on-error: true
        uses: reidgao/spot-runner/gcp/start@v2
        with:
          project: my-ci-project
          workload-identity-provider: projects/123456789/locations/global/workloadIdentityPools/github/providers/github
          service-account: ci-runner@my-ci-project.iam.gserviceaccount.com
          github-token: ${{ secrets.RUNNER_REGISTRATION_PAT }}
          sizes: '[{"type":"c4d-highcpu-96","workers":60},{"type":"c4d-highcpu-48","workers":30}]'
          prepull-images: mcr.microsoft.com/playwright:v1.59.1-noble
```

```yaml
      - uses: reidgao/spot-runner/gcp/stop@v2
        with:
          project: my-ci-project
          workload-identity-provider: projects/123456789/locations/global/workloadIdentityPools/github/providers/github
          service-account: ci-runner@my-ci-project.iam.gserviceaccount.com
          github-token: ${{ secrets.RUNNER_REGISTRATION_PAT }}
          instance-id: ${{ needs.spot-start.outputs.instance-id }}
          label: ${{ needs.spot-start.outputs.label }}
```

The sweep and the bake take the same three sign-in inputs. If you already sign in with `google-github-actions/auth`, pass its access token as `access-token` instead.

## Inputs

| Action | Input | Default | Meaning |
| --- | --- | --- | --- |
| all | `project` | | The project ID |
| all | `workload-identity-provider` | | The provider's full name, from the setup above |
| all | `service-account` | | The account to act as; empty to use the federated token directly |
| all | `access-token` | | A Google access token to use instead of the two above |
| start, stop | `github-token` | | The registration token's source; see the overview |
| start | `sizes` | `[{"type":"c4d-highcpu-96"},{"type":"c4d-highcpu-48"}]` | Machine types to try, best first. Extra fields come back in the `size` output |
| start, bake | `region` | `us-central1` | Every zone of it is tried |
| start | `prepull-images` | | Docker images the job needs, pulled at boot when the image lacks them |
| start | `disk-gb` | `100` | Boot disk size |
| start | `max-run-minutes` | `90` | Google Cloud deletes the VM after this; keep it above the job's timeout |
| start, bake | `image-family` | `ci-runner-<repository>` | This repository's image family |
| stop | `instance-id`, `label` | | The start action's outputs; `instance-id` is `zone/name` |
| sweep | `prefixes` | `ci-` | VM names to sweep, among those with the `ci-runner` label |
| sweep | `max-age-minutes` | `75` | Delete VMs older than this, in any zone |
| bake | `prepull-images` | | Docker images to bake in |
| bake | `node-versions` | | Node versions for the runner's tool cache, where `actions/setup-node` finds them |
| bake | `builder-types` | `c4d-highcpu-4 n2-highcpu-4 e2-standard-4` | Types to build on, first available wins |
| bake | `keep` | `2` | Images of the family to keep |

Start outputs `ready`, `label`, `instance-id` and `size`. There is no price output: Google Cloud does not publish spot prices through the Compute Engine API. They change at most once a month; see the Spot VMs pricing page.

## How a VM is chosen

The start action lists the region's zones, keeps those that offer each wanted type, and tries them best type first, zone by zone, up to eight times. A stockout (`ZONE_RESOURCE_POOL_EXHAUSTED`) or a quota error moves on to the next offer; a quota is usually regional, so it fails the same way in every zone. A sign-in or permission error stops at once.

## The bake

The builder is a small standard VM, not a spot one, so it cannot be reclaimed halfway through, and it only stops when it powers off, so its disk is still there to make the image from. It installs Docker, pulls the given images, installs the runner (in `/home/ci/actions-runner`, with its work directory in `/home/ci/work`, so a newer runner swapped in at boot keeps the tool cache) and Node, runs `cloud-init clean` and powers off. The action follows the builder's serial port output while it works, so a failing step ends the bake at once and prints the step's last lines; then it creates the image in the family, deletes the builder and prunes the family.

## Troubleshooting

- **`no GitHub OIDC token`**: the job lacks `permissions: id-token: write`.
- **`iam.serviceAccounts.getAccessToken` denied**: the `roles/iam.workloadIdentityUser` binding names another repository, or the provider's attribute condition rejects this one.
- **`QUOTA_EXCEEDED` in every zone**: request quota for the family, and for Preemptible CPUs or CPUs in the region.
- **The runner never comes online**: the first-boot script's log is on the serial console:

  ```bash
  gcloud compute instances get-serial-port-output ci-my-repo-123-1 --zone us-central1-a --project my-ci-project | grep startup-script
  ```

## Running it locally

```bash
export GCP_ACCESS_TOKEN="$(gcloud auth print-access-token)" GCP_PROJECT=my-ci-project
export GITHUB_REPOSITORY=owner/repo GITHUB_RUN_ID=test1 GITHUB_RUN_ATTEMPT=1 RUNNER_GITHUB_TOKEN="$(gh auth token)"
SPOT_SIZES='[{"type":"c4d-highcpu-8"}]' node gcp-runner.mjs start
INSTANCE_ID=us-central1-a/ci-repo-test1-1 RUNNER_LABEL=ci-repo-test1-1 node gcp-runner.mjs stop
```

The runner's name is also its label. Besides it, GitHub gives every runner the default labels `self-hosted`, `Linux` and `X64`, so a test runner can only serve a workflow that asks for its name or for `self-hosted` alone.
