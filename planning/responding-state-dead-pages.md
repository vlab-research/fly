# RESPONDING State Bug: Zombie Users on Dead Pages

**Status**: Sub-issue of RESPONDING-stuck-state bug  
**Date**: 2026-05-24  
**Data source**: MCP query snapshot of `chatroach.public.states` (~21:00 UTC)

## The Problem

Dead Facebook pages accumulate users stuck in `RESPONDING` state indefinitely. These users cannot recover because the page's token is expired/revoked, making them unable to receive messages. While mostly harmless (not actively sending), they pollute metrics and cloud the more urgent active-page leakage issue.

**Total stuck users examined**: 860 in `current_state = 'RESPONDING'`

## Time-Since-Stuck Distribution

| Duration | Count | % |
|-----------|-------|-----|
| 20m–1h | 3 | <1% |
| 1h–6h | 3 | <1% |
| 6h–24h | 5 | <1% |
| 1–7 days | 59 | 7% |
| 7+ days | 790 | **92%** |

The widely-reported "self-heals in 1–2 hours" pattern accounts for only ~5–11 users. The vast majority never recover.

## Page Concentration (stuck > 5 minutes)

| Page ID | Stuck Users | Last Activity | Status |
|---------|-------------|---------------|----|
| 102096262181249 (Lebanon `lbexp`) | 528 | 2026-05-16 (~8 days) | Recently dead |
| 141093161438689 | 76 | 2026-04-02 (~52 days) | Dead |
| 101435865704727 | 68 | Today | **Active** |
| 106964348279583 | 47 | Today | **Active** |
| 107658111474228 | 44 | 2025-02-09 (~15 months) | Long dead |
| 106503598318841 | 35 | 2025-10-12 (~7 months) | Long dead |
| 102437228671476 | 14 | Not queried | Unknown |
| 1855355231229529 | 10 | Not queried | Unknown |
| 101734981838685 | 8 | Not queried | Unknown |
| 758018254333043 | 7 | Today | Active |

**61% of stuck users (528/860) are on a single dead Lebanon page.** Several pages with no successful state updates in 7+ months still hold RESPONDING zombies.

## Dean Retry Exhaustion

Every sampled stuck user has `retry_count = 30` (MAX). Retry sequence:
1. Dean burns through 30 retries in ~2–3 hours
2. Sets `next_retry` ~6–7 weeks in future
3. Abandons the user — state remains `RESPONDING`
4. No transition to `ERROR` or `BLOCKED`

**Retry tracking**: 853/860 users (99%) have `error_tag IS NULL` — silent failures, not caught errors. Retry count location (state_json field vs table column) needs verification.

## Sub-Problem Definition

**What**: Zombie pages with expired tokens retain stuck users indefinitely  
**Impact**: Dead users can't recover; metrics pollution; obscures active-page leakage  
**Severity**: Low-to-medium (mostly harmless; lower priority than active-page trickle)

## Recommended Next Steps (This Sub-Problem Only)

1. **Bulk cleanup**: Transition stuck users on dead pages to a terminal state (`BLOCKED` or `ABANDONED`)
   - Cutoff: "No successful state update on page in 30 days"
2. **Dean check**: If a page has no successful FB-bound traffic in N days, skip retry queueing for users on it
3. **Defer deeper fix**: Leave Dean's exhaustion-to-terminal-state transition for the active-pages plan

## Out of Scope

- Why Dean burns 30 retries in 2–3 hours (not exponential backoff)
- Why exhausted users stay in RESPONDING instead of transitioning to ERROR/BLOCKED
- The active-page trickle (separate urgent priority)
