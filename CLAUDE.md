# Development Philosophy & Working Approach

## Default Mode: Direct & Lightweight

For most tasks, work directly — read files, make edits, run commands. Use subagents when the task benefits from parallelism or isolation, not by default.

For complex features that need structured exploration, planning, and implementation, invoke `/three-phase` to activate the full Scout → Plan → Build workflow with coordinator-only mode and git worktrees.

## Core Principles

### 1. **Clarify Before You Code**
- **Ask questions** when requirements seem unclear or broad
- **Document the plan** before implementation
- **Get user confirmation** on approach and priorities
- **Pivot quickly** when user clarifies different needs

### 2. **Incremental Progress**
- **Small, focused changes** that can be tested immediately
- **Add complexity gradually** - a little bit at a time
- **Test after each meaningful change**
- **Maintain working state** throughout development

### 3. **Sequential Implementation Strategy**
- **Use TaskCreate/TaskUpdate tools** for multi-step features to track progress and maintain focus
- **Break complex features into independent chunks** that can be dispatched to parallel subagents
- **Complete one component fully before moving to next** - avoid partial implementations
- **Follow existing patterns and naming conventions** when extending systems

### 4. **Functional Core, Imperative Shell**
- **All business logic must be pure functions** — deterministic, no side effects, easy to test
- **Push IO and side effects to the edges** — database calls, API requests, file operations happen in a thin outer layer that calls into the pure core
- **Prefer data transformations over mutation** — map/filter/reduce over loops with side effects
- **Design for testability** — if a function is hard to test, it's doing too much or mixing concerns
- **Separate "decide" from "do"** — compute what should happen (pure), then execute it (impure)

### 5. **Error Handling Philosophy**
- **"Fail fast and loud"** approach - better than silent failures
- **Provide specific error messages** about what's missing and why
- **Use consistent error handling patterns** across the codebase
- **Surface actionable information** to help users resolve issues

### 6. **Quality Gates**
- **Zero-warning builds** as baseline standard
- **All functionality verified** after changes
- **Clear git commits** that tell the story
- **Working software** over perfect architecture

## Agent Selection Quick Reference

When using subagents, pick the right type:

| Task | Agent Type |
|------|-----------|
| Read/search/document code | `explore` (lowercase — has Write/Edit) |
| Write/edit code | `fullstack-engineer` |
| Run commands | `Bash` |
| Test code | `qa-testing-engineer` |
| Deploy/infra | `devops-deployment-optimizer` |

- **Do NOT use `Explore` (capital E) or `Plan`** — these agents cannot write files
- **NEVER use `subagent_type=general-purpose`** — too vague, use a specific type
- **NEVER use `EnterPlanMode`** — use `/three-phase` for structured planning instead

## Documentation Locations

| Location | Purpose | Contains |
|----------|---------|----------|
| **`<project>/README.md`** | Describe the PARTS | Architecture, structure, setup, dependencies |
| **`documentation/<feature>.md`** | Describe the FEATURES | Cross-component behavior, data flows |
| **`planning/`** | Plans for WORK | Implementation plans, findings (temporary) |

## Git Worktree Workflow

Use a git worktree for **any feature that requires running code** — tests, builds, dev servers. Simple config tweaks or docs can stay in the main worktree.

```bash
# Create worktree for a new feature
git worktree add ../fly-<feature-name> -b feature/<feature-name>

# All work happens in the worktree
cd ../fly-<feature-name>

# When done and merged, clean up
git worktree remove ../fly-<feature-name>
git branch -d feature/<feature-name>
```

**Notes**:
- Dependencies are NOT shared — each worktree needs its own `npm install`
- Avoid port conflicts when running multiple dev servers
- When dispatching subagents to a worktree, include the worktree path in the prompt

## Build & Infrastructure Practices

### Docker Build Optimization
- **Use Docker cache by default** - leverage layer caching for faster builds
- **Only disable cache (`--no-cache`) when necessary** - broken layer cache, stale dependencies, or debugging
- **Order Dockerfile instructions from least to most frequently changing**
- **Use specific dependency versions** rather than `latest`

### Kubernetes & Helm Development
- **Push to Docker registry instead of `kind load`** - registry-based images are reproducible
- **Update Helm chart values** when changing image tags or versions
- **Avoid local shortcuts** that work once but fail on restart
- **Test full deployment cycle** - ensure images can be pulled and deployed fresh

### Infrastructure Debugging
- **Understand before fixing** - investigate root causes rather than symptoms
- **Use logs and metrics** as primary debugging tools
- **Document infrastructure changes** - capture why decisions were made
- **Version infrastructure code** - treat Helm, docker-compose, and k8s manifests like application code

## Emergency Procedures

### If Build Breaks
1. **Immediate rollback**: Revert to last working state
2. **Test rollback**: Verify system works
3. **Analyze root cause**: What went wrong?
4. **Fix properly**: Address cause, not just symptoms

### If Requirements Change Mid-Work
1. **Stop current work** and assess impact
2. **Clarify new requirements** with user
3. **Update plan** based on new direction
4. **Get agreement** before proceeding

### If Complexity Gets Out of Hand
1. **Step back** and reassess the real problem
2. **Simplify approach** to focus on core needs
3. **Break down** into smaller, manageable pieces
4. **Get fresh perspective** from Plan agent on architecture

## Key Success Factors

1. **Communication**: Clear questions, documented plans, user alignment
2. **Incremental progress**: Small steps, frequent testing, working software
3. **Quality focus**: Standards maintained, technical debt managed
4. **Adaptability**: Quick pivots when priorities or understanding changes

**Philosophy**: Build the right thing, the right way, one step at a time.
