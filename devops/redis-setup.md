# Redis Setup for VLAB

## Overview

Redis has been added to the VLAB deployment as a caching layer. The setup uses Bitnami's Redis Helm chart with different configurations for each environment.

## Architecture

### Production & Staging
- **Architecture**: Replication (Master + 1 Replica)
- **Authentication**: Enabled
- **Persistence**: Enabled with SSD storage
- **Monitoring**: Prometheus metrics enabled
- **Network Policy**: Enabled for security

### Test & Online-Test
- **Architecture**: Standalone
- **Authentication**: Disabled (for simplicity)
- **Persistence**: Enabled with smaller storage
- **Monitoring**: Prometheus metrics enabled
- **Network Policy**: Disabled (for development)

## Configuration Details

### Production
- Master: 256Mi-512Mi memory, 250m-500m CPU
- Replica: 256Mi-512Mi memory, 250m-500m CPU
- Storage: 8Gi SSD per instance

### Staging
- Master: 128Mi-256Mi memory, 100m-200m CPU
- Replica: 128Mi-256Mi memory, 100m-200m CPU
- Storage: 2Gi SSD per instance

### Test/Online-Test
- Master: 64Mi-128Mi memory, 50m-100m CPU
- Storage: 1Gi per instance

## Connection Details

### Service Names
- **Production/Staging**: `gbv-redis-master` (master), `gbv-redis-replicas` (replicas)
- **Test/Online-Test**: `gbv-redis-master`

### Ports
- **Redis**: 6379
- **Metrics**: 9121

### Authentication
- **Production/Staging**: Password required (stored in Kubernetes secret)
- **Test/Online-Test**: No authentication

## Usage Examples

### Connecting from Applications
```bash
# Production/Staging (with auth)
redis-cli -h gbv-redis-master -p 6379 -a $REDIS_PASSWORD

# Test/Online-Test (no auth)
redis-cli -h gbv-redis-master -p 6379
```

### Environment Variables for Applications
```yaml
env:
  - name: REDIS_HOST
    value: "gbv-redis-master"
  - name: REDIS_PORT
    value: "6379"
  - name: REDIS_PASSWORD
    valueFrom:
      secretKeyRef:
        name: gbv-redis
        key: redis-password
```

## Monitoring

Redis metrics are automatically scraped by Prometheus and available in Grafana. Key metrics include:
- Connected clients
- Memory usage
- Command statistics
- Replication lag (for replication mode)

## Scaling

### Horizontal Scaling
- **Replication Mode**: Add more replicas by updating `replica.replicaCount`
- **Cluster Mode**: Switch to Redis Cluster architecture for true horizontal scaling

### Vertical Scaling
- Adjust `resources.requests` and `resources.limits` in values files
- Increase `persistence.size` for more storage

## Backup and Recovery

Redis data is persisted to PVCs. For additional backup:
1. Use Redis RDB snapshots
2. Implement application-level backup strategies
3. Consider using Redis Cluster for better data distribution

## Security Considerations

- Network policies restrict access to Redis pods
- Authentication enabled in production/staging
- Non-root container execution
- Pod security contexts configured
- TLS encryption available (not enabled by default)

## Troubleshooting

### Common Issues
1. **Connection Refused**: Check if Redis pods are running
2. **Authentication Failed**: Verify password in Kubernetes secret
3. **Memory Issues**: Monitor memory usage and adjust limits
4. **Replication Lag**: Check replica status and network connectivity

### Useful Commands
```bash
# Check Redis pods
kubectl get pods -l app.kubernetes.io/name=redis

# View Redis logs
kubectl logs -l app.kubernetes.io/name=redis

# Check Redis metrics
kubectl port-forward svc/vlab-redis-master 6379:6379

# Access Redis CLI
kubectl exec -it deployment/vlab-redis-master -- redis-cli
``` 