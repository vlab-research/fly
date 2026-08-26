# Grafana — metrics dashboards at `grafana.vlab.digital` (Google login)

Grafana is **not its own Helm release**. It ships as the `grafana` subchart of
`kube-prometheus-stack`, so everything about it is configured in
**`devops/prometheus/values.yaml`** under the `grafana:` key and applied with a
`helm upgrade` of the `prometheus` release. There is no `grafana` release in
`helm list`.

## What's in this directory

| Path | What it is |
|---|---|
| `.env-example` | Committed template for `.env` → the `grafana-oauth` secret |
| `dashboards/` | **Historical** hand-exported dashboard JSON (2020–2021). Reference only — not provisioned by anything. The live copies are in Grafana's database. |
| `queries.sql` | Ad-hoc SQL behind some of the older study dashboards |

Dashboards that are actually **provisioned as code** live elsewhere, in
`devops/grafana-dashboards/` (a real Helm release whose ConfigMaps carry the
`grafana_dashboard: "1"` label that Grafana's sidecar watches).

## Architecture

```
Browser ─► grafana.vlab.digital (nginx ingress, TLS via cert-manager)
   ▼
 Grafana ──[auth.google]──► accounts.google.com  ("Sign in with Google")
   │   allowlist enforced by role_attribute_path + role_attribute_strict
   ├─► Prometheus  http://prometheus-kube-prometheus-prometheus.monitoring:9090/
   ├─► Loki        http://loki:3100
   └─► PostgreSQL  gbv-cockroachdb-public.vprod.svc.cluster.local:26257  (CockroachDB)
```

All three datasources are stored in the database, not provisioned from values —
the `PostgreSQL` one points at **prod CockroachDB** and is what the older study
dashboards (`form-status`, `campaign-optimization`, `responses-over-time`) query.
Grafana rewrote the Postgres datasource backend after 7.x, so include a
Cockroach-backed dashboard in the post-upgrade spot-check, not just a Prometheus
one.

**Deliberately different from Karma.** Karma (`devops/karma/`) has no auth of its
own, so it sits behind oauth2-proxy in nginx `auth_request` mode, needs two
ingresses, and reaches Google through Auth0 as an OIDC broker. Grafana has a
first-class OAuth client, so it does its own login **straight to Google**: one
ingress, no auth annotations, no oauth2-proxy, no broker — and, unlike the shared
anonymous session oauth2-proxy would produce, real per-user identity inside
Grafana.

The two tools genuinely differ here; this is not drift. Karma's setup predates
this and can be simplified later if anyone cares (oauth2-proxy has a native
`google` provider too).

### Access control lives in Grafana

Google will authenticate **any** Google account, so something must decide who
gets in. That gate is `role_attribute_path` in
`devops/prometheus/values.yaml`:

```ini
role_attribute_path = contains(['nandan@vlab.digital','nandanmarkrao@gmail.com'], email) && 'Admin' || ''
role_attribute_strict = true
```

A JMESPath yielding `'Admin'` for an allowlisted email and `''` for everyone
else; `role_attribute_strict` turns "no valid role" into a **denied login**. It
fails closed.

> ### ⚠️ `skip_org_role_sync: false` is what makes the two lines above do anything
>
> Grafana defaults `skip_org_role_sync` to **`true` for the google provider**
> (Google carries no role or group claims). While it is true, `role_attribute_path`
> and `role_attribute_strict` are **ignored outright — no warning, no log line** —
> and every authenticated account falls through to
> `[users] auto_assign_org_role` (`Viewer`). The allowlist is silently inert and
> **anyone with any Google account can log in**.
>
> This shipped that way on 2026-08-05 and the instance was open for about an hour.
> The tell: the *allowlisted* account also came out as `Viewer` instead of `Admin`.
> If the allowlist ever appears to stop working, check this setting first:
>
> ```bash
> kubectl -n monitoring exec deploy/prometheus-grafana -c grafana -- sh -c \
>   'wget -qO- "http://admin:$GF_SECURITY_ADMIN_PASSWORD@localhost:3000/api/admin/settings"' \
>   | python3 -c "import sys,json;print(json.load(sys.stdin)['auth.google'])"
> ```
>
> Read the **effective** settings, not `values.yaml` — the failure is a default
> you never wrote winning over config you did.

> **Adding or removing a teammate** = edit that one line, then `helm upgrade`
> (below). This is the equivalent of Karma's `oauth2-proxy-emails` ConfigMap.

`allowed_domains` is deliberately **not** used: the team is not on a single
Google Workspace domain (one member signs in with a personal `gmail.com`
address), and a domain allowlist would admit *everyone* at any listed domain.

Two things that look like bugs but aren't:

- A rejected user sees an **HTTP 500**, not a clean 403. Long-standing Grafana
  papercut ([grafana/grafana#82971](https://github.com/grafana/grafana/issues/82971)).
- The **username/password form is still on the login page**, on purpose. It is
  the break-glass path for the local `admin` account if the OAuth config breaks.
  Don't set `disable_login_form` without another way in.

`oauth_allow_insecure_email_lookup` is left at its secure default (`false`).
That is only safe because this instance has exactly one pre-existing user
(`admin`, with the non-routable address `admin@localhost`), so no OAuth login
can collide with an existing account by email.

## Why the OAuth client is not in Terraform

Because **no live Google API can create one**. It is not an oversight:

1. The only Terraform-supported path was `google_iap_brand` + `google_iap_client`,
   which requires the project to belong to an organization. `toixotoixo` has no
   organization — `gcloud iap oauth-brands list` returns
   `INVALID_ARGUMENT: Project must belong to an organization`.
2. Those resources ride the IAP OAuth Admin API, which Google **permanently shut
   down on 2026-03-19**. Dead even with an organization.

So a human creates the client once in the Cloud Console (step 2 below) and its
id/secret live in `devops/grafana/.env` like every other secret in this repo.

Routing Grafana through an identity broker (Auth0, as Karma does) *would* make
the client Terraform-manageable — that was the first design here, and it was
rejected. It buys a tidier `.tf` file in exchange for an extra vendor in the
critical login path and a standing broker-admin credential that can rewrite every
application in the tenant, including the production dashboard SPA. The allowlist
works identically either way, so the broker adds no access-control value. Not
worth it to avoid a one-time console form.

## First-time setup

Two of these steps are **console work only a human can do** — there is no API for
either. They are called out as such; don't look for a way to script them.

### 1. DNS — 👤 human, NS1 console

`vlab.digital` is on NS1 (the GCP project has zero Cloud DNS zones), so this is
not Terraformable from here either. Add a CNAME matching `alerts.vlab.digital`:

```
grafana.vlab.digital.  CNAME  vlab-cluster.vlab.digital.
```

There is no wildcard record, so this step is required. Verify before applying —
cert-manager cannot issue until the name resolves:

```bash
dig +short grafana.vlab.digital    # expect: vlab-cluster.vlab.digital. then 35.241.211.222
```

### 2. Google OAuth client — 👤 human, Google Cloud Console

In project **`toixotoixo`**, under **Google Auth Platform** (older consoles:
*APIs & Services → OAuth consent screen / Credentials*):

**a. Branding / consent screen.** App name **`Virtual Lab`** — keep it generic,
not "Virtual Lab Grafana". The consent screen is **per-project**, shared by every
OAuth client in `toixotoixo`, so a Grafana-specific name would show up on the
login screen of the next internal tool too. Add a user support email and a
developer contact email.

Leave **Application home page / privacy policy / terms of service blank**. They
are only required to *publish* (see c).

**b. Audience: `External`.** `Internal` is not available — it requires the
project to be in a Google Workspace organization, and this one isn't. External
is also what lets the personal `gmail.com` address in the allowlist sign in.

**c. Leave publishing status as `Testing`. Do NOT publish.** Add the team's
Google accounts under **Test users**.

Publishing an External app **requires public home page, privacy policy and terms
of service links** — none of which are worth authoring for a 3-person internal
metrics dashboard. Testing status requires none of them, and its limits don't
bite here:

- The 100-test-user cap is irrelevant at this team size.
- The much-cited *"authorizations expire after 7 days"* does **not** apply, because
  Google exempts apps requesting only name/email/profile —
  exactly our `openid email profile` — from that expiry and from the unverified
  app warning screen.

> **Testing status is NOT a second allowlist.** It is tempting to assume the Test
> users list restricts who can sign in. It does not — the same exemption that
> removes the 7-day expiry (apps requesting only name/email/profile) also means
> users **do not need to be on the trusted-user list**. This was confirmed the
> hard way on 2026-08-05: an account that was never added as a test user logged
> in successfully.
>
> **`role_attribute_path` is the only thing gating access.** There is exactly one
> allowlist, and it lives in `devops/prometheus/values.yaml`.

**d. Clients → Create client → Application type: `Web application`.** Name it
`Grafana (prod)`. Set:

| Field | Value |
|---|---|
| Authorized redirect URIs | `https://grafana.vlab.digital/login/google` |
| Authorized JavaScript origins | *(leave empty — server-side flow)* |

That redirect URI is not a guess: Grafana derives it as
`<root_url>/login/google`, confirmed by inspecting the 302 it emits. It must
match **exactly**, including scheme and the absence of a trailing slash.

**e. Copy the client ID and client secret** — the secret is only fully shown at
creation time.

### 3. The `grafana-oauth` secret

```bash
cp devops/grafana/.env-example devops/grafana/.env
# paste the two values from step 2e into devops/grafana/.env, then:
cd devops
bash secrets.sh monitoring grafana-oauth grafana/.env
```

### 4. Snapshot the Grafana disk, then apply

The `helm upgrade` bumps Grafana **7.4.2 → 12.4.0**, which runs **433**
irreversible schema migrations against the sqlite DB on the PVC (`migration_log`
goes from 278 rows to 711). Snapshot first.

Note the snapshot source is the **GCE disk name** from the PV's
`csi.volumeHandle` — *not* the PV or PVC name:

```bash
PV=$(kubectl -n monitoring get pvc prometheus-grafana -o jsonpath='{.spec.volumeName}')
DISK=$(kubectl get pv "$PV" -o jsonpath='{.spec.csi.volumeHandle}')
DISK=${DISK##*/}          # gke-toixo-...-dyn-pvc-<uuid>
ZONE=$(kubectl get pv "$PV" -o jsonpath='{.metadata.labels.topology\.kubernetes\.io/zone}')

gcloud compute disks snapshot "$DISK" --zone="$ZONE" \
  --snapshot-names=grafana-pre-12-4-0 --project=toixotoixo
```

```bash
cd devops
helm upgrade prometheus prometheus-community/kube-prometheus-stack \
  --version 39.0.0 -n monitoring -f prometheus/values.yaml
kubectl -n monitoring rollout status deployment/prometheus-grafana
kubectl -n monitoring get certificate grafana-tls -w   # until READY=True
```

### 5. Verify

- `https://grafana.vlab.digital` → login page with a **"Sign in with Google"**
  button.
- Click it → Google account chooser → back into Grafana as **Admin**.
- **Confirm the gate works**: log in with a Google account *not* in
  `role_attribute_path` and confirm it is **rejected** (as a 500). This is the
  one check that proves the instance isn't open to the internet — do not skip it.
- Spot-check dashboards, especially the pre-2022 ones (see below).

## Dashboards and the Angular removal

**29 of 32 dashboards contain AngularJS panels** (`graph` ×28 dashboards,
`singlestat`, one `table-old`), because they were authored on Grafana 7 and are
stored at schema version 22–27. Grafana removed AngularJS in 11.x, so those
panels are **auto-migrated in the browser at load time** — `graph` → `timeseries`,
`singlestat` → `stat`, `table-old` → `table`. They render, but legend/axis
styling can shift, and storage keeps the old schema until someone saves the
dashboard.

Unaffected: the three modern, code-provisioned dashboards from
`devops/grafana-dashboards/` (`live-traffic`, `kafka-consumer-health`,
`kafka-broker-app-health`), which already use `timeseries`/`stat`/`bargauge`.

The `kubernetes-*`, `node-exporter-*`, `prometheus-overview`, `alertmanager-*`
and `etcd` dashboards come from kube-prometheus-stack 39.0.0's own ConfigMaps.
Those are re-provisioned from 2022-era JSON on every sidecar sync, so they stay
Angular-shaped in storage and lean on auto-migration on every load. They get
modernised by upgrading kube-prometheus-stack itself — a separate, much larger
job (Prometheus Operator 0.58 → current, CRDs, alert rules).

## Verifying a version bump

**Do not bump `grafana.image.tag` without this dry-run.** Grafana **13.x will not
start** against this database:

```
Error: ✗ unable to start dualwrite service due to migration error:
unified storage data migration failed: migration failed (id = playlists migration):
SQL logic error: no such column: p.uid (1)
```

Grafana 13's unified-storage migrator queries `playlist.uid`, but no schema
migration ever adds that column to a `playlist` table created by Grafana 7 — its
`create playlist table v2` migration is already recorded in `migration_log`, so
the newer definition is skipped. The dashboards/folders migration succeeds, then
playlists aborts startup. `12.4.0` is the newest verified-good tag.

Reproduce against a copy of real data, never in the cluster:

```bash
POD=$(kubectl -n monitoring get pod -l app.kubernetes.io/name=grafana -o name | head -1)
kubectl -n monitoring cp "${POD#pod/}:/var/lib/grafana/grafana.db" /tmp/gtest/grafana.db -c grafana
chmod -R 777 /tmp/gtest

docker run --rm -p 3010:3000 -v /tmp/gtest:/var/lib/grafana \
  -e GF_AUTH_ANONYMOUS_ENABLED=true -e GF_AUTH_ANONYMOUS_ORG_ROLE=Admin \
  grafana/grafana:<candidate-tag>

curl -s localhost:3010/api/health                          # database: ok
curl -s 'localhost:3010/api/search?type=dash-db&limit=200' | jq length   # expect 32
```

Then open `http://localhost:3010` and eyeball the Angular-heavy dashboards
(Campaign Optimization, Form Status, Strimzi Kafka Exporter) before committing.

Rollback, if a bump does get applied and fails: restore the disk snapshot from
step 4. Reverting only the image tag is *usually* enough — 7.4.2 does still open
a DB that 13.x migrated — but a partially-migrated schema is not a state to
trust, so prefer the snapshot.

## Known issue: two provisioned datasources both claim `isDefault`

Grafana logs this on every datasource-sidecar reload, and provisioning fails
wholesale:

```
Failed to provision data sources  error="datasource.yaml config is invalid.
Only one datasource per organization can be marked as default"
```

Two ConfigMaps labelled `grafana_datasource=1` each set `isDefault: true`:

| ConfigMap | Owner | Datasource |
|---|---|---|
| `loki-loki-stack` | `loki` release (loki-stack 2.6.5, 2022) | Loki |
| `prometheus-kube-prometheus-grafana-datasource` | `prometheus` release | Prometheus |

**Pre-existing, not caused by the 12.4.0 upgrade** — both ConfigMaps are ~4 years
old. Grafana 7 tolerated the clash; 12 rejects the batch.

**Impact is limited:** all three datasources already exist in Grafana's database
(`Loki` holds the default flag, `Prometheus` and `PostgreSQL` don't) and all
query fine, so dashboards work. What's broken is *provisioning* — an edit to
either ConfigMap will not be applied.

**Fix** (not done — it means touching the unrelated `loki` release): set the Loki
datasource's `isDefault: false` in the `loki` release's values so Prometheus is
the sole provisioned default, then `helm upgrade` that release. Worth doing
before anyone relies on datasource provisioning.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Rollout hangs, `Multi-Attach error for volume ... already used by pod(s)` | The PVC is `ReadWriteOnce` and the deployment strategy is `RollingUpdate`. Fixed by `deploymentStrategy.type: Recreate` in `devops/prometheus/values.yaml` — don't remove it, and don't unblock a stuck rollout by deleting the old pod by hand. |
| `Error 400: redirect_uri_mismatch` from Google | The Authorized redirect URI on the client doesn't match `<root_url>/login/google` exactly. Check for a trailing slash or `http` vs `https`. |
| **Any Google account can log in** | `skip_org_role_sync` has reverted to Grafana's google-provider default of `true`, making the allowlist inert. See the boxed warning under "Access control". Check *effective* settings via `/api/admin/settings`. |
| Allowlisted user logs in as **Viewer** instead of Admin | Same cause — `role_attribute_path` is not being evaluated at all. |
| `Error 403: access_denied` from Google | The consent screen is in Testing *and* the scopes aren't the exempt name/email/profile set. Add the account under **Test users**. |
| Logged in but **500** | Working as designed for a non-allowlisted email. Otherwise check the `role_attribute_path` JMESPath. |
| Login button missing | `grafana-oauth` secret absent or not picked up — `envFrom` is read at container start, so `rollout restart` after `secrets.sh`. |
| Cert stuck `READY=False` | DNS not resolving yet; `kubectl -n monitoring describe certificate grafana-tls`. |
| Pod crash-loops after a tag bump | Almost certainly the playlists migration above. Revert the tag, restore the snapshot. |

## See also

- `documentation/alerting.md` §8 — Grafana alongside Karma and ntfy
- `devops/karma/README.md` — the oauth2-proxy + Auth0 pattern, and why Grafana differs
- `documentation/secrets.md` — the `.env` → secret convention
- `infra/README.md` — the Terraform stack, and what is deliberately not in it
