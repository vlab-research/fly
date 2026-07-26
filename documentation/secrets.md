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

Each app's `.gitignore` ignores `.env` and `.env-*`, with `!.env-example`
re-included. **`.env-example` is the committed template** — it carries every key
with placeholder values and any gotchas worth recording, and should be updated
whenever a key is added or removed.

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
