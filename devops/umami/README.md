# Umami — self-hosted web analytics for every site we run

OSS ([umami.is](https://umami.is), MIT), cookieless, no browser storage. Runs in its
own `analytics` namespace at `https://analytics.vlab.digital`, with its own
Postgres. **It is shared:** each web property is a "website" inside this one
instance. vlab.digital was the first (vlab.digital `DECISIONS.md` D-009).

## Files
- `umami.yaml` — Namespace, Postgres StatefulSet (10Gi `standard-rwo`), Umami
  Deployment (image pinned), Service, Ingress (cert-manager `letsencrypt-prod`).
- `backup.yaml` — nightly CronJob: **purge visitor data older than 24 months**, then
  `pg_dump` to the `umami-backups` PVC, 14 dumps kept.
- `.env-umami` (gitignored) — the `umami` secret: `POSTGRES_PASSWORD`,
  `DATABASE_URL`, `APP_SECRET`. **`APP_SECRET` keys the visitor hash; changing it
  resets unique-visitor continuity.**
- `.env-umami-admin` (gitignored) — the `admin` login for the UI. The image ships
  with `admin`/`umami`; it was changed on first boot and must be on any rebuild.

## Deploy

```bash
kubectl create namespace analytics
bash devops/secrets.sh analytics umami devops/umami/.env-umami
kubectl apply -f devops/umami/umami.yaml -f devops/umami/backup.yaml
kubectl -n analytics get certificate umami-tls -w
```

DNS: `analytics.vlab.digital` CNAME `vlab-cluster.vlab.digital` (Netlify DNS).

## Adding a site

1. In the UI, **Settings → Websites → Add website**. Copy its website id.
2. Add to the site's `<head>`:
   ```html
   <script defer src="https://analytics.vlab.digital/script.js"
           data-website-id="<id>" data-domains="<the site's domain>"></script>
   ```
3. **Required, not optional** (see "The visitor's IP" below): proxy it first-party
   through the site's host, as vlab.digital does on Netlify in `_redirects`. This
   also stops ad blockers dropping it:
   ```
   /p/s.js       https://analytics.vlab.digital/script.js   200
   /p/api/send   https://analytics.vlab.digital/api/send    200
   ```
   and use `src="/p/s.js"`.
4. **Update that site's privacy policy.** vlab.digital `privacy.html` §2.5 is a
   worked example of what Umami actually stores.

## The visitor's IP, and why `CLIENT_IP_HEADER` is set

Umami never stores the IP. It uses it once, for the country/region/city lookup and
for the session hash. Behind a Netlify proxy the request comes from Netlify's edge,
so Umami would see Netlify. Netlify puts the real address in
`X-Nf-Client-Connection-Ip` (verified 2026-09-23 against an echo endpoint), and
the deployment sets `CLIENT_IP_HEADER` to it.

**A site that calls `analytics.vlab.digital` directly, not through Netlify, will NOT
get visitor IPs today.** Umami falls back to `X-Forwarded-For`, but the
ingress-nginx LoadBalancer runs `externalTrafficPolicy: Cluster` (checked
2026-09-23), which SNATs the source address to a node's, so every direct visitor
looks like one of our own nodes. Proxy through the site's host as vlab.digital
does, or fix the ingress (`Local` policy, a cluster-wide change) first.

Symptom of a broken chain either way: every visitor is one or two sessions,
located in a Netlify region or in Belgium.

## Retention is a published promise

vlab.digital's privacy policy says website analytics are deleted after 24 months.
Umami does not do this itself; `backup.yaml` does. Change the interval there and in
every privacy policy that cites it, together.

## Upgrading

Read the release notes. Umami runs its Prisma migrations on start-up, so take a
manual dump first:

```bash
kubectl -n analytics create job umami-backup-pre-upgrade --from=cronjob/umami-backup
```

Restore:
```bash
kubectl -n analytics exec -i umami-postgres-0 -- \
  pg_restore -U umami -d umami --clean --if-exists < umami-YYYYMMDD.dump
```

## Not covered

The dumps live on a PVC in the same zone as the data. That protects against a bad
upgrade or a mistaken delete, not the loss of the cluster's disks. If analytics
history ever becomes worth that, copy `devops/backup/minio-media-mirror.yaml`'s
pattern to GCS.
