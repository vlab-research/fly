# Secrets & Environment Configuration

All Kubernetes secrets are derived from **gitignored `.env` files** in the repo.
The `.env` file is the source of truth; the cluster secret is a build artifact of
it. Nothing is ever edited directly in the cluster.

## The rule

> **Never `kubectl patch` / `kubectl edit` a secret.**
> Edit the `.env` file, re-run the apply script, restart the pods.

An in-cluster edit is invisible to the repo, unreviewable in a diff, and silently
reverted the next time anyone runs the apply script. Drift between the `.env`
file and the live secret is how a value ends up wrong in one environment and
right in another with no record of why.

## Where the files live

Env files sit next to the app they configure, suffixed by environment:

| File | Feeds secret | Namespace |
|---|---|---|
| `replybot/.env` | `gbv-bot-envs` | local / dev |
| `replybot/.env-staging` | `gbv-bot-envs` | `vstag` |
| `exporter/.env` | — (local dev only) | local |
| `exporter/.env-staging` | `exporter` | `vstag` |
| `dashboard-server/.env-media-production` | `dashboard-media` | `vprod` |
| `dashboard-server/.env-media-staging` | `dashboard-media` | `vstag` |
| `media-proxy/.env-media-production` | `media-proxy` | `vprod` |
| `media-proxy/.env-media-staging` | `media-proxy` | `vstag` |
| `devops/backup/.env-media-mirror` | `minio-media-mirror` | `minio` |

Each app's `.gitignore` ignores `.env` and `.env-*`, with `!.env-example`
re-included. **`.env-example` is the committed template** — it carries every key
with placeholder values and any gotchas worth recording, and should be updated
whenever a key is added or removed. (`devops/.gitignore` re-includes
`.env-*-example` instead, because its templates are named per-secret.)

## Scoped service accounts for object storage

Storage credentials are **never** the MinIO root credential, and never typed by
hand. The pattern, established for the media buckets:

1. The **policy is a checked-in JSON file** — `devops/minio-media-policy.json`
   (dashboard-server: Get/Put/Delete on `media/*`),
   `devops/minio-media-readonly-policy.json` (media-proxy: Get only, **no
   ListBucket**), `devops/minio-media-backup-policy.json` (the mirror CronJob:
   Get + List). The file is the source of truth; nothing is composed at a prompt.
2. A **script applies it** — `devops/minio/media-svcacct.sh <production|staging>`
   creates the bucket, runs `mc` *inside the cluster* so the root credential is
   read from the `minio-auth` Secret by the pod and never touches a shell or the
   repo, creates each service account against its policy file, and writes the
   generated keys into the gitignored `.env` files above.
3. Then the ordinary flow: `devops/secrets.sh`, then `kubectl rollout restart`.

Re-running rotates the key pairs. The predecessor,
`devops/minio/staging-svcacct.sh`, embeds its policy in the script — the media
scripts read theirs from a file instead, so the policy is reviewable in a diff on
its own.

**Why three accounts and not one.** They want different halves and the
differences are load-bearing, not tidiness: the public read path must not hold
`s3:ListBucket`, because asset URLs are unguessable capability URLs and a list
permission would turn the bucket into a directory listing; `mc mirror` *does*
need `ListBucket`, so it is a separate identity rather than a reason to widen the
proxy's; and none of them can reach the exports buckets, which hold respondent
data.

### Never `__FILL_` in a committed file

`devops/secrets.sh` refuses to apply an env file whose values still contain
`__FILL_...__`. `devops/backup/.env-media-mirror-example` uses that deliberately
for the backup endpoint and its credentials: the operator must choose an
off-cluster S3 target, and the placeholder turns "not chosen yet" into a loud
failure at apply time instead of a nightly CronJob mirroring into nowhere.

## Applying

Generic form — any secret, any namespace:

```bash
cd devops
bash secrets.sh <namespace> <secret-name> <env-file>

# e.g.
bash secrets.sh vstag exporter ../exporter/.env-staging
```

`accounts.sh` is a thin convenience wrapper for the `gbv-bot-envs` case:

```bash
cd devops && bash accounts.sh vstag ../replybot/.env-staging
```

Both are idempotent (`create --dry-run=client | kubectl apply`), so re-running is
always safe.

### Pods do not reload secrets

`envFrom`/`env.valueFrom.secretKeyRef` values are injected at container start.
Changing a secret does **not** restart anything — you must roll the deployment:

```bash
kubectl rollout restart deployment/gbv-exporter -n vstag
```

Forgetting this is the most common reason a "fixed" secret appears to still be
broken.

## Bootstrapping an env file from a live secret

When a secret was created by hand before this convention existed, seed the file
from the cluster once, then treat the file as authoritative:

```bash
kubectl get secret <name> -n <namespace> -o json \
  | jq -r '.data | to_entries[] | "\(.key)=\(.value|@base64d)"'
```

Review the output before saving — hand-created secrets are exactly the ones
likely to contain a stale or malformed value.

## Gotcha: database URL schemes

`DATABASE_URL` values consumed by libpq-based clients (psycopg, `pg`, anything
speaking the PostgreSQL wire protocol) **must** use the `postgres://` or
`postgresql://` scheme. libpq recognises only those two as connection URIs. Any
other scheme — including the intuitive-looking `cockroachdb://` — is not
rejected as an unknown scheme; it falls through to keyword/value DSN parsing,
which splits the string on `=` and produces a confusing error naming most of
your URL as an option:

```
invalid connection option "cockroachdb://root@gbv-cockroachdb-public:26257/chatroach?sslmode"
```

CockroachDB's own docs and `cockroach` CLI output sometimes show
`cockroachdb://`, which is where the mistake originates. It works for
CockroachDB-aware drivers, not for libpq.

## See also

- `documentation/staging.md` — which secrets exist in `vstag` and what they hold
- `devops/secrets.sh` — the apply script
- `devops/run-migration.sh` — the schema-migration counterpart
