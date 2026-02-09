# States Exposure Feature — Deployment Guide

**Status**: Ready to deploy
**Branch**: `feature/states-exposure` (rebased on main)
**Date**: 2026-02-09

## Pre-Deployment Checklist

- [x] All code implemented and tested
- [x] Backend tests written (syntax verified)
- [x] Integration tests pass locally (requires live DB)
- [x] Frontend components complete
- [x] Tabbed layout integrated
- [x] Branch rebased on main
- [x] Documentation complete

## What's Being Deployed

### Backend Changes (dashboard-server)

**New Files:**
```
dashboard-server/
├── api/states/
│   ├── states.controller.js        (82 lines)
│   ├── states.routes.js            (14 lines)
│   ├── states.test.js              (376 lines)
│   └── index.js                    (1 line)
└── queries/states/
    ├── states.queries.js           (154 lines)
    └── index.js                    (1 line)
```

**Modified Files:**
```
dashboard-server/
├── api/index.js                    (+1 line: route registration)
├── README.md                       (+updated with test patterns)
└── package-lock.json               (+dependencies from test file)
```

**Database:**
- No schema changes
- Queries read from existing `states` table
- No migrations needed

**Environment Variables:**
- No new environment variables required

### Frontend Changes (dashboard-client)

**New Files:**
```
dashboard-client/
└── src/containers/StatesExplorer/
    ├── StatesSummary.js            (120 lines)
    ├── StatesList.js               (258 lines)
    ├── StateDetail.js              (300 lines)
    ├── StatesExplorer.css          (8 lines)
    └── index.js                    (6 lines)
```

**Modified Files:**
```
dashboard-client/
├── src/containers/SurveyScreen/SurveyScreen.js         (46 lines added, 15 removed)
├── src/containers/index.js                            (+exports)
└── README.md                                           (+documentation)
```

**Dependencies:**
- Uses existing: React, react-router-dom, antd, moment
- No new packages required

## Deployment Steps

### 1. Backend Deployment

```bash
# Build new dashboard-server image
docker build -t dashboard-server:new .

# Update Kubernetes deployment
kubectl set image deployment/dashboard-server \
  dashboard-server=dashboard-server:new \
  -n production

# Or update Helm chart if using Helm
helm upgrade fly ./devops/vlab/charts/ \
  --set dashboard.image.tag=new
```

**Verification:**
```bash
# Check health
curl https://api.fly.vlab.digital/api/v1/surveys/test/states/summary \
  -H "Authorization: Bearer $TOKEN"

# Watch for errors
kubectl logs -f deployment/dashboard-server -n production
```

### 2. Frontend Deployment

```bash
# Frontend deploys via Netlify on git push or manual trigger
git push origin feature/states-exposure:main

# Or manually trigger Netlify build:
# - Go to https://app.netlify.com/sites/fly-vlab/deploys
# - Click "Trigger deploy"
```

**Verification:**
```bash
# After Netlify build completes
curl https://fly.vlab.digital
# Navigate to a survey → Monitor tab should appear
```

## Testing After Deployment

### Smoke Tests (5 minutes)

1. **Auth check**
   - Log in with test account
   - Should see surveys list

2. **Tab navigation**
   - Go to `/surveys/TestSurvey/edit`
   - Should see 3 tabs: Edit, Monitor, Export
   - Click Monitor tab → should load StatesSummary

3. **Monitor tab**
   - StatesSummary should show participant counts
   - Click on a state breakdown → should navigate to list
   - StatesList should show participants with filters
   - Click a participant → should show StateDetail

4. **Permissions**
   - Log in as different user
   - Try to access another user's survey states
   - Should get 403 error

5. **Deep linking**
   - Direct navigate to `/surveys/TestSurvey/monitor/list`
   - Should show Monitor tab active with list displayed
   - Browser back/forward should work

### Full Testing (30 minutes)

See `states-exposure-completion.md` "Testing Checklist (for QA)" section

## Rollback Plan

If issues are found post-deployment:

### Rollback Backend
```bash
# Revert to previous image
kubectl set image deployment/dashboard-server \
  dashboard-server=dashboard-server:previous \
  -n production
```

### Rollback Frontend
```bash
# Netlify: go to Deploy settings → Deploys
# Click "Publish" on previous successful build
```

**Both should be instant** — no data migration or cleanup needed.

## Performance Considerations

### Backend
- `summary()` query groups by state/form — should be fast (< 100ms)
- `list()` query with pagination — limit 50 default, adjust if needed
- Consider index on `current_form` for large state tables

### Frontend
- StatesList pagination is server-side — good for large datasets
- StateDetail loads full state_json (size varies, usually < 100KB)
- No client-side caching implemented (could optimize future)

## Monitoring

### Key Metrics to Watch
1. **API response times** — `/states` endpoints should be < 500ms
2. **Error rates** — watch for 5xx errors (DB issues)
3. **Memory usage** — state_json parsing, ensure no memory leaks
4. **Load** — if many users access Monitor tab simultaneously

### Alert Conditions
- API error rate > 1% for states endpoints
- API p95 latency > 2s for list endpoint
- Memory usage spike in dashboard-server pods

## Post-Deployment Tasks

1. **Monitor error logs** for first 24 hours
2. **Gather user feedback** on UI/UX
3. **Document any issues** found during testing
4. **Plan future enhancements** based on feedback

## Support

### For Technical Issues
- Check `documentation/states-debugging.md` for states system details
- Check API error messages in dashboard-server logs
- Check browser console for frontend errors

### Common Issues & Fixes

**Issue**: "Access denied to this survey"
- **Cause**: User doesn't own survey with that survey_name
- **Fix**: Verify user has forms in that survey

**Issue**: StateDetail shows "State Not Found"
- **Cause**: Requested userid doesn't exist in that survey
- **Fix**: Verify userid from StatesList

**Issue**: No data in StatesSummary
- **Cause**: No participants in survey states table
- **Fix**: Run test survey to generate state data

**Issue**: Monitor tab doesn't appear
- **Cause**: Frontend not updated / cache not cleared
- **Fix**: Hard refresh browser (Ctrl+Shift+R), check Netlify build status

## Questions?

Refer to:
- `states-exposure-completion.md` — Feature overview and architecture
- `STATES_EXPOSURE_README.md` — Documentation index
- `states-exposure-plan.md` — Implementation details and design decisions
