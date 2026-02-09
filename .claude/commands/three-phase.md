---
description: "Activate the full three-phase workflow (Scout → Plan → Build) for complex features. Use this when the task requires deep exploration, formal planning, and structured implementation."
allowed-tools: ["Task", "Bash", "Read", "Write", "Edit", "Glob", "Grep", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "AskUserQuestion"]
---

# Three-Phase Workflow: Activated

You are now operating in **structured three-phase mode** for a complex feature. Follow this workflow strictly.

## Mode: Coordinator-Only

**The main agent must NEVER directly read files, explore the codebase, grep for code, or write/edit code.** Delegate ALL such work to subagents via the Task tool.

Main agent responsibilities:
- **Communicate with the user** — ask questions, clarify requirements, report results
- **Coordinate subagents** — dispatch work to the right agent type, synthesize their results
- **Manage task flow** — track progress, sequence work, handle dependencies
- **Make high-level decisions** — choose approaches, resolve conflicts between agent outputs

**Why**: The main agent's context window is precious. Every file read or grep result pollutes it. Subagents have isolated context that is discarded after use.

**Rules**:
- Use `subagent_type=explore` (lowercase) for ANY codebase exploration, investigation, and documentation writing — this agent has ALL tools including Write/Edit
- Use `subagent_type=fullstack-engineer` for ANY code writing, editing, or implementation
- **Do NOT use `subagent_type=Explore` (capital E) or `subagent_type=Plan`** — these agents CANNOT write files (no Write/Edit tools), making them unable to produce documentation
- Use `subagent_type=Bash` for simple command execution (build, test, git)
- Use `subagent_type=qa-testing-engineer` for test creation and validation
- Use `subagent_type=devops-deployment-optimizer` for infrastructure and deployment work
- **NEVER use `subagent_type=general-purpose`**
- **NEVER use `run_in_background=true`** — background agents have permission issues in worktrees. Instead, launch multiple foreground agents in a single message for parallel execution
- **NEVER use Read, Glob, Grep, Edit, or Write tools directly** (exception: CLAUDE.md / `.claude/` memory files)
- **NEVER use `EnterPlanMode`** — use this three-phase cycle instead
- **Every subagent prompt MUST instruct the agent to update living docs** (`<project>/README.md` for components, `documentation/` for features, `planning/` for plans)

## Phase 1: SCOUT & DOCUMENT

**Goal**: Understand the problem space and capture knowledge to files — NOT to context.

1. **Dispatch `explore` agents** (lowercase) to investigate the relevant code, patterns, and dependencies
2. **Agents write findings to the appropriate location**:
   - **`<project>/README.md`** — what the component IS (architecture, structure, setup, dependencies)
   - **`documentation/<feature>.md`** — how a FEATURE works across components (cross-cutting functionality, user-facing behavior, data flows)
   - **`planning/<task>-findings.md`** — raw investigation notes specific to THIS task (temporary, consumed by Phase 2)
3. **Main agent reads only the summary** from the findings file (not raw code)
4. **Confirm understanding with user** before proceeding

**Every Explore agent prompt MUST include**: "Write investigation notes to `planning/<task>-findings.md`. Update `<project>/README.md` if you learn something new about what the component is or how it's structured. Update `documentation/<feature>.md` if you learn something new about cross-cutting feature behavior."

## Phase 2: PLAN

**Goal**: Produce a concrete, step-by-step implementation plan based on documentation.

1. **Dispatch `explore` agent** with a reference to the findings file from Phase 1
2. **Agent reads findings**, does additional targeted exploration if needed
3. **Agent writes plan to** `planning/<task>-plan.md`, including:
   - **Required Reading** — links to docs that an implementer MUST read before starting
   - Files to create/modify (with rationale)
   - Specific changes per file
   - Test strategy
   - Acceptance criteria
4. **Main agent reviews plan summary** with user, gets approval before Phase 3

**Phase 2 agent prompt MUST include**: "Read `planning/<task>-findings.md` for context. Write your plan to `planning/<task>-plan.md`. Update `<project>/README.md` if your planning reveals new component knowledge. Update `documentation/<feature>.md` if your planning clarifies cross-cutting feature behavior."

## Phase 3: BUILD & TEST (Parallel)

**Goal**: Implement the plan in small chunks, with testing in parallel.

1. **Create a git worktree** for the feature:
   ```bash
   git worktree add ../fly-<feature-name> -b feature/<feature-name>
   ```
2. **Break the plan into independent work units** that can run in parallel
3. **Dispatch fullstack-engineer agents** for implementation — each gets ONE chunk. **Include the worktree path** in the prompt
4. **Dispatch qa-testing-engineer agents** in parallel for tests. **Include the worktree path**
5. **Each agent updates documentation** (`<project>/README.md`, `documentation/<feature>.md`)
6. **Commit progress** via Bash agent after each verified chunk
7. **Repeat** until plan is complete

**Build agent prompt MUST include**: "Read `planning/<task>-plan.md` for the implementation plan. You are implementing chunk N. Update `<project>/README.md` if you learn something new about the component. Update `documentation/<feature>.md` if the feature's cross-cutting behavior changes."

## After All Phases

1. **Merge the feature branch** into main
2. **Remove the worktree and branch** — `git worktree remove ../fly-<feature-name> && git branch -d feature/<feature-name>`
3. **Clean up `planning/` artifacts** — remove task-specific findings/plans
4. **Final documentation pass** — verify READMEs and docs are up to date
5. **Verify all objectives** were met

## Agent Communication Protocol

Agents do NOT pass information through the main agent's context. Instead:
1. **Agent A writes findings to a file** (e.g., `planning/<task>-findings.md`)
2. **Main agent tells Agent B** to read that file
3. **Agent B reads the file** and writes its own output to another file
4. **Main agent reads only short summaries** to report progress

## Documentation Mandate

Every subagent MUST update living documentation:

| Location | Purpose | Contains |
|----------|---------|----------|
| **`<project>/README.md`** | Describe the PARTS | Architecture, structure, setup, dependencies |
| **`documentation/<feature>.md`** | Describe the FEATURES | Cross-component behavior, data flows |
| **`planning/`** | Plans for WORK | Implementation plans, findings (temporary) |

**Rules**:
- Never overwrite existing content — append or update relevant sections
- Document the "why" — reasoning, trade-offs, alternatives considered
- `planning/` is temporary — cleaned up after work is done
- README.md and `documentation/` are permanent
