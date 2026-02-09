# Development Philosophy & Working Approach

## CRITICAL: Main Agent is Coordinator-Only

**The main (top-level) agent must NEVER directly read files, explore the codebase, grep for code, or write/edit code.** It must ALWAYS delegate these tasks to subagents via the Task tool. The main agent's sole responsibilities are:

- **Communicate with the user** - ask questions, clarify requirements, report results
- **Coordinate subagents** - dispatch work to the right agent type, synthesize their results
- **Manage task flow** - track progress, sequence work, handle dependencies
- **Make high-level decisions** - choose approaches, resolve conflicts between agent outputs

**Why**: The main agent's context window is precious and shared across the entire conversation. Every file read, every grep result, every code exploration pollutes this context and degrades performance over time. Subagents have their own isolated context that is discarded after use, keeping the main agent lean and effective.

**Rules**:
- Use `subagent_type=Explore` for ANY codebase exploration, file searching, or code understanding
- Use `subagent_type=fullstack-engineer` for ANY code writing, editing, or implementation
- Use `subagent_type=Plan` for architectural analysis and implementation planning
- Use `subagent_type=Bash` for simple command execution (build, test, git)
- Use `subagent_type=qa-testing-engineer` for test creation and validation
- Use `subagent_type=devops-deployment-optimizer` for infrastructure and deployment work
- **NEVER use `subagent_type=general-purpose`** - it's too vague and bloats context. Use a specific agent type instead
- **NEVER use Read, Glob, Grep, Edit, or Write tools directly** - always delegate to a subagent
- The only exception is reading/writing CLAUDE.md or `.claude/` memory files for self-configuration
- **NEVER use `EnterPlanMode`** - plan mode encourages the main agent to explore directly (Read, Glob, Grep are available in plan mode), which pollutes the main context. Use the three-phase cycle instead — it provides the same user-approval gate between planning and execution while keeping the main agent's context clean
- **Every subagent prompt MUST instruct the agent to update living docs** (`<project>/README.md` for components, `documentation/` for features, `planning/` for plans)
- **Follow the three-phase cycle**: Scout & Document → Plan → Build & Test (see Working Process)

## Core Principles

### 1. **Clarify Before You Code**
- **Ask questions** when requirements seem unclear or broad
- **Document the plan** before implementation
- **Get user confirmation** on approach and priorities
- **Pivot quickly** when user clarifies different needs

### 2. **Agent Coordination for Quality**
- **All work happens through subagents** - the main agent coordinates, never executes
- **Get consensus** from relevant agents before major decisions
- **Explore agent**: All codebase reading, searching, and understanding
- **Plan agent**: Architectural analysis and implementation planning
- **Fullstack-Engineer**: Technical validation and implementation
- **QA-Testing-Engineer**: Test creation and validation
- **DevOps-Deployment-Optimizer**: Infrastructure and deployment impact
- **Coordinate execution** across agents for complex tasks

### 3. **Incremental Progress**
- **Small, focused changes** that can be tested immediately
- **Add complexity gradually** - a little bit at a time
- **Test after each meaningful change**
- **Maintain working state** throughout development

### 4. **Sequential Implementation Strategy**
- **Use TaskCreate/TaskUpdate tools** for multi-step features to track progress and maintain focus
- **Break complex features into independent chunks** that can be dispatched to parallel subagents
- **Complete one component fully before moving to next** - avoid partial implementations
- **Follow existing patterns and naming conventions** when extending systems

### 5. **Functional Core, Imperative Shell**
- **All business logic must be pure functions** — deterministic, no side effects, easy to test
- **Push IO and side effects to the edges** — database calls, API requests, file operations happen in a thin outer layer that calls into the pure core
- **Prefer data transformations over mutation** — map/filter/reduce over loops with side effects
- **Design for testability** — if a function is hard to test, it's doing too much or mixing concerns
- **Separate "decide" from "do"** — compute what should happen (pure), then execute it (impure)

### 6. **Error Handling Philosophy**
- **"Fail fast and loud"** approach - better than silent failures
- **Provide specific error messages** about what's missing and why
- **Use consistent error handling patterns** across the codebase
- **Surface actionable information** to help users resolve issues

### 7. **Quality Gates**
- **Zero-warning builds** as baseline standard
- **All functionality verified** after changes
- **Clear git commits** that tell the story
- **Working software** over perfect architecture

## Working Process: The Three-Phase Cycle

Every task follows this cycle. **No phase may be skipped.**

### Phase 1: SCOUT & DOCUMENT
**Goal**: Understand the problem space and capture knowledge to files — NOT to context.

1. **Dispatch Explore agents** to investigate the relevant code, patterns, and dependencies
2. **Agents write findings to the appropriate location**:
   - **`<project>/README.md`** — describe what the component IS (architecture, structure, setup, dependencies)
   - **`documentation/<feature>.md`** — describe how a FEATURE works across components (cross-cutting functionality, user-facing behavior, data flows)
   - **`planning/<task>-findings.md`** — raw investigation notes specific to THIS task (temporary, consumed by Phase 2)
3. **Main agent reads only the summary** from the findings file (not raw code)
4. **Confirm understanding with user** before proceeding

**Every Explore agent prompt MUST include**: "Write investigation notes to `planning/<task>-findings.md`. Update `<project>/README.md` if you learn something new about what the component is or how it's structured. Update `documentation/<feature>.md` if you learn something new about cross-cutting feature behavior."

### Phase 2: PLAN
**Goal**: Produce a concrete, step-by-step implementation plan based on documentation.

1. **Dispatch Plan agent** with a reference to the findings file from Phase 1
2. **Plan agent reads findings**, does additional targeted exploration if needed
3. **Plan agent writes plan to** `planning/<task>-plan.md`, including:
   - **Required Reading** — links to the `<project>/README.md`, `documentation/<feature>.md`, and any other docs that an implementer MUST read before starting work
   - Files to create/modify (with rationale)
   - Specific changes per file
   - Test strategy
   - Acceptance criteria
4. **Main agent reviews plan summary** with user, gets approval before Phase 3

**Plan agent prompt MUST include**: "Read `planning/<task>-findings.md` for context. Write your plan to `planning/<task>-plan.md`. Update `<project>/README.md` if your planning reveals new component knowledge. Update `documentation/<feature>.md` if your planning clarifies cross-cutting feature behavior."

### Phase 3: BUILD & TEST (Parallel)
**Goal**: Implement the plan in small chunks, with testing in parallel.

1. **Create a git worktree** for the feature (see [Git Worktree Workflow](#git-worktree-workflow)). All build and test work happens in the worktree, not the main working directory
2. **Break the plan into independent work units** that can run in parallel
3. **Dispatch fullstack-engineer agents** for implementation — each gets ONE chunk from the plan. **Include the worktree path** in the agent prompt
4. **Dispatch qa-testing-engineer agents** in parallel to write/run tests for completed chunks. **Include the worktree path** in the agent prompt
4. **Each agent updates documentation**:
   - Update `<project>/README.md` with any new component knowledge (architecture, patterns, setup)
   - Update `documentation/<feature>.md` with any new cross-cutting feature behavior
   - Test agents document test coverage and any gaps found
5. **Commit progress** via Bash agent after each verified chunk
6. **Repeat** until plan is complete

**Build agent prompt MUST include**: "Read `planning/<task>-plan.md` for the implementation plan. You are implementing chunk N. Update `<project>/README.md` if you learn something new about the component. Update `documentation/<feature>.md` if the feature's cross-cutting behavior changes."

### After All Phases
1. **Merge the feature branch** into main
2. **Remove the worktree and branch** — `git worktree remove ../fly-<feature-name> && git branch -d feature/<feature-name>`
3. **Clean up `planning/` artifacts** — remove task-specific findings/plans if work is complete (these are temporary); leave future-state plans
4. **Final documentation pass** — dispatch an agent to verify `<project>/README.md` and `documentation/<feature>.md` are up to date
5. **Verify all objectives** were met
6. **Plan next steps** if applicable

## Agent Usage Guidelines

### Main Agent Context Hygiene
- **NEVER use Read, Glob, Grep, Edit, or Write directly** - these fill the main context with file contents
- **Summarize subagent results** for the user rather than passing through raw output
- **Launch parallel subagents** when multiple independent explorations are needed
- **Keep main agent responses focused** on coordination, decisions, and user communication
- **If tempted to "just quickly check" a file** - use an Explore subagent instead
- The only exception: reading/writing CLAUDE.md or `.claude/` memory files

### Documentation Mandate (ALL Agents)
Every subagent MUST update living documentation as part of its work. Three locations, three purposes:

| Location | Purpose | Contains |
|----------|---------|----------|
| **`<project>/README.md`** | Describe the PARTS | What a component is, its architecture, structure, setup, dependencies, local dev instructions |
| **`documentation/<feature>.md`** | Describe the FEATURES | How functionality works across components — user-facing behavior, data flows, cross-cutting concerns |
| **`planning/`** | Plans for WORK | Implementation plans, future-state designs, task findings — things not yet built or in progress |

**Rules**:
- **Never overwrite** existing README.md or documentation content — append or update relevant sections
- **Document the "why"** — capture reasoning, trade-offs, and alternatives considered
- **`planning/` is temporary** — task-specific findings and plans get cleaned up after work is done. Only future-state plans persist.
- **README.md is permanent** — component knowledge accumulates over time
- **`documentation/` is permanent** — feature documentation accumulates and evolves as features change
- If an agent discovers something about the codebase that isn't documented, it documents it in the right location

### Agent Selection Quick Reference
| Task | Agent Type | Never Do Directly |
|------|-----------|-------------------|
| Read/search code | `Explore` | Read, Glob, Grep |
| Write/edit code | `fullstack-engineer` | Edit, Write |
| Plan architecture | `Plan` | - |
| Run commands | `Bash` | - |
| Test code | `qa-testing-engineer` | - |
| Deploy/infra | `devops-deployment-optimizer` | - |

### How Agents Communicate
Agents do NOT pass information through the main agent's context. Instead:
1. **Agent A writes findings to a file** (e.g., `planning/<task>-findings.md`)
2. **Main agent tells Agent B** to read that file (e.g., "Read `planning/<task>-findings.md` for context")
3. **Agent B reads the file** and does its work, writing its own output to another file
4. **Main agent reads only short summaries** to report progress to the user

This keeps the main agent's context clean while allowing rich information transfer between agents.


## Git Worktree Workflow

### When to Use Worktrees
Use a git worktree for **any feature that requires running code** — tests, compilation, builds, dev servers, or any process that touches the filesystem beyond simple edits. This covers most complex code changes. Simple config tweaks, typo fixes, or documentation-only changes can stay on a branch in the main worktree.

### Convention
Worktrees live as **sibling directories** to the main repo, named `fly-<feature-name>`:

```bash
# Create worktree for a new feature
git worktree add ../fly-<feature-name> -b feature/<feature-name>

# All work happens in the worktree
cd ../fly-<feature-name>

# When done and merged, clean up
git worktree remove ../fly-<feature-name>
git branch -d feature/<feature-name>
```

### Why Worktrees
- **Main worktree stays clean** — always reflects current main/deployed state, no stashing or half-finished work
- **Isolation for running code** — each worktree has its own working directory, so tests, builds, and dev servers don't interfere with each other or with main
- **Safe experimentation** — if things go sideways, delete the worktree; main is untouched
- **Parallel features** — multiple features can be in progress simultaneously without branch-switching overhead

### Important Notes
- **Dependencies are NOT shared** — each worktree needs its own `npm install` / dependency setup
- **Port conflicts** — don't run dev servers from multiple worktrees simultaneously without adjusting ports
- **Subagents working in worktrees** — when dispatching build/test agents for a feature, include the worktree path in the prompt so the agent operates in the right directory

### Integration with Three-Phase Cycle
- **Phase 1 (Scout)**: Runs in the main worktree — exploration is read-only
- **Phase 2 (Plan)**: Runs in the main worktree — planning is read-only
- **Phase 3 (Build & Test)**: **Create a worktree** at the start of this phase. All implementation and testing happens in the worktree
- **After All Phases**: Merge the feature branch, then **remove the worktree** as part of cleanup

## Build & Infrastructure Practices

### Docker Build Optimization
- **Use Docker cache by default** - leverage layer caching for faster builds
- **Only disable cache (`--no-cache`) when necessary** - broken layer cache, stale dependencies, or debugging specific issues
- **Order Dockerfile instructions from least to most frequently changing** - stable dependencies early, code/config later
- **Use specific dependency versions** rather than `latest` to avoid cache invalidation
- **Separate concerns in layers** - avoid combining steps that change at different frequencies

### Build System Best Practices
- **Optimize for build time first** - faster feedback loops enable faster development
- **Minimize layer count** - combine related commands where appropriate
- **Use build cache strategically** - understand which files trigger cache misses
- **Profile build performance** - identify bottlenecks before they accumulate
- **Document build dependencies** - make clear what each Dockerfile layer needs and why

### Kubernetes & Helm Development
- **Push to Docker registry instead of `kind load`** - registry-based images are reproducible and persist across cluster restarts
- **Update Helm chart values** when changing image tags or versions - keep charts aligned with actual deployments
- **Avoid local shortcuts** that work once but fail on restart - invest in proper workflow upfront
- **Use consistent image references** - tag images clearly so you know exactly what's deployed
- **Test full deployment cycle** - ensure images can be pulled and deployed fresh, not just loaded locally

### Infrastructure Debugging
- **Understand before fixing** - investigate root causes rather than symptoms
- **Use logs and metrics** as primary debugging tools
- **Maintain working state** - test rollbacks and recovery procedures
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
2. **Coordination**: Proper agent consultation and consensus building  
3. **Incremental progress**: Small steps, frequent testing, working software
4. **Quality focus**: Standards maintained, technical debt managed
5. **Adaptability**: Quick pivots when priorities or understanding changes

**Philosophy**: Build the right thing, the right way, one step at a time.
