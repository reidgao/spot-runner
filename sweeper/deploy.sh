#!/usr/bin/env bash
# Deploys the sweeper Worker. Run it by hand, signed in to wrangler.
#
#   sweeper/deploy.sh            deploy; asks for the keys the first time
#   sweeper/deploy.sh --dry-run  the same, but the Worker only logs what it
#                                would destroy (DRY_RUN=1)
#   sweeper/deploy.sh --rotate   ask for the keys again
#
# The keys are typed or pasted at a prompt that echoes nothing, reach wrangler
# in a private temporary file that is deleted right after, and are never on a
# command line. Set CLOUDFLARE_ACCOUNT_ID when the wrangler login sees more
# than one account. Extra wrangler arguments go after `--`.
set -euo pipefail

WRANGLER=(npx --yes wrangler@4.157.0)
cd "$(dirname "$0")"

dry_run=false
rotate=false
extra=()
while (($#)); do
  case "$1" in
    --dry-run) dry_run=true ;;
    --rotate) rotate=true ;;
    --) shift; extra=("$@"); break ;;
    *) echo "usage: sweeper/deploy.sh [--dry-run] [--rotate] [-- wrangler arguments]" >&2; exit 2 ;;
  esac
  shift
done

args=(deploy -c wrangler.jsonc)
$dry_run && args+=(--var DRY_RUN:1)

# The first deploy and a rotation send the keys; any other deploy keeps the
# ones the Worker has.
has_keys=false
if ! $rotate && "${WRANGLER[@]}" secret list -c wrangler.jsonc 2>/dev/null | grep -q '"TENCENT_SECRET_KEY"'; then
  has_keys=true
fi

if ! $has_keys; then
  secrets="$(mktemp)"
  trap 'rm -f "$secrets"' EXIT
  chmod 600 "$secrets"
  read -rsp 'Tencent Cloud SecretId of the sweeper sub-user: ' TENCENT_SECRET_ID; echo
  read -rsp 'Tencent Cloud SecretKey: ' TENCENT_SECRET_KEY; echo
  read -rsp 'Push URL for alerts (Enter for none): ' NOTIFY_URL; echo
  [[ -n "$TENCENT_SECRET_ID" && -n "$TENCENT_SECRET_KEY" ]] || { echo 'Stopped: both keys are needed.' >&2; exit 1; }
  export TENCENT_SECRET_ID TENCENT_SECRET_KEY NOTIFY_URL
  # JSON, so a key with a dollar sign or a quote arrives as typed.
  node -e '
    const { TENCENT_SECRET_ID, TENCENT_SECRET_KEY, NOTIFY_URL } = process.env;
    const secrets = { TENCENT_SECRET_ID, TENCENT_SECRET_KEY, ...(NOTIFY_URL ? { NOTIFY_URL } : {}) };
    process.stdout.write(JSON.stringify(secrets));
  ' > "$secrets"
  unset TENCENT_SECRET_ID TENCENT_SECRET_KEY NOTIFY_URL
  args+=(--secrets-file "$secrets")
fi

"${WRANGLER[@]}" "${args[@]}" ${extra[@]+"${extra[@]}"}
