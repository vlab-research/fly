# Dashboard Server Ingress Configuration - Findings

## Summary
Investigated Helm charts and values files for dashboard-server ingress configuration. Found the ingress is configured in two places and there is NO existing `proxy-body-size` annotation set for the dashboard.

## Dashboard Ingress Configuration

### 1. Production Configuration
**File:** `/home/nandan/Documents/vlab-research/fly/devops/values/production.yaml`
**Lines:** 404-478

```yaml
dashboard:
  replicaCount: 3
  image:
    repository: vlabresearch/dashboard
    tag: *vdashboard
    pullPolicy: IfNotPresent
  # ... env vars ...
  ingress:
    enabled: true
    annotations:
      cert-manager.io/cluster-issuer: letsencrypt-prod
      kubernetes.io/ingress.class: nginx
    hosts:
      - host: fly-dashboard-api.vlab.digital
        paths:
          - path: '/'
            pathType: Prefix
    tls:
      - secretName: fly-dashboard-cert
        hosts:
          - fly-dashboard-api.vlab.digital
  service:
    type: ClusterIP
    port: 80
```

### 2. Staging Configuration
**File:** `/home/nandan/Documents/vlab-research/fly/devops/values/staging.yaml`
**Lines:** 400-468

```yaml
dashboard:
  replicaCount: 1
  image:
    repository: vlabresearch/dashboard
    tag: *vdashboard
    pullPolicy: Always
  # ... env vars ...
  ingress:
    enabled: true
    annotations:
      cert-manager.io/cluster-issuer: letsencrypt-prod
      kubernetes.io/ingress.class: nginx
    hosts:
      - host: gbv-dashboard-staging.nandan.cloud
        paths:
          - path: '/'
            pathType: Prefix
    tls:
      - secretName: gbv-dashboard-cert
        hosts:
          - gbv-dashboard-staging.nandan.cloud
  service:
    type: ClusterIP
    port: 80
```

## Helm Chart Template

**File:** `/home/nandan/Documents/vlab-research/fly/devops/vlab/charts/dashboard-0.0.2.tgz`
**Extracted to:** `/tmp/dashboard/`

**Ingress Template:** `/tmp/dashboard/templates/ingress.yaml`
**Lines:** 10-12

The template uses annotations from values:
```yaml
  {{- with .Values.ingress.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
```

## Existing proxy-body-size Pattern

**File:** `/home/nandu/Documents/vlab-research/fly/devops/values/minio.yaml`
**Line:** 15

The minio API ingress has a `proxy-body-size` annotation set:
```yaml
apiIngress:
  enabled: true
  hostname: storage-api.vlab.digital
  ingressClassName: nginx
  tls: true
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-body-size: "1000m"
```

## Key Findings

1. **Dashboard ingress is NOT configured with proxy-body-size**
   - Production: No proxy-body-size annotation
   - Staging: No proxy-body-size annotation
   - This means nginx defaults to 1m limit for request body size

2. **Ingress Template supports annotations**
   - The Helm template at `/tmp/dashboard/templates/ingress.yaml` properly renders all annotations from `values.ingress.annotations`
   - Adding the annotation to the values will automatically be rendered in the ingress

3. **Naming Convention**
   - Nginx annotation format: `nginx.ingress.kubernetes.io/proxy-body-size: "<size>"`
   - The minio example uses "1000m" for 1GB
   - This is the standard Nginx Ingress Controller annotation

4. **Values Files Are Environment-Specific**
   - `/home/nandan/Documents/vlab-research/fly/devops/values/production.yaml` for production
   - `/home/nandu/Documents/vlab-research/fly/devops/values/staging.yaml` for staging
   - Both need to be updated to enable large uploads

## Chart Structure
```
dashboard-0.0.2.tgz contains:
├── Chart.yaml (v0.0.2)
├── values.yaml (empty or minimal)
├── templates/
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── ingress.yaml (lines 10-12 handle annotations)
│   ├── _helpers.tpl
│   └── NOTES.txt
└── .helmignore
```

## Required Changes Summary

To enable large file uploads for the dashboard:

1. **Add to Production Values** (`/home/nandu/Documents/vlab-research/fly/devops/values/production.yaml`):
   - Add `nginx.ingress.kubernetes.io/proxy-body-size: "5000m"` to the `dashboard.ingress.annotations` section

2. **Add to Staging Values** (`/home/nandu/Documents/vlab-research/fly/devops/values/staging.yaml`):
   - Add `nginx.ingress.kubernetes.io/proxy-body-size: "5000m"` to the `dashboard.ingress.annotations` section

The ingress template will automatically render these annotations into the Kubernetes Ingress resource.
