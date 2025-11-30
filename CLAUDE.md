# Development Philosophy & Working Approach

## Core Principles

### 1. **Clarify Before You Code**
- **Ask questions** when requirements seem unclear or broad
- **Document the plan** before implementation
- **Get user confirmation** on approach and priorities
- **Pivot quickly** when user clarifies different needs

### 2. **Agent Coordination for Quality**
- **Get consensus** from relevant agents before major decisions
- **Engineering-Director**: Strategic oversight and final assessment
- **Fullstack-Engineer**: Technical validation and implementation
- **DevOps-Deployment-Optimizer**: Infrastructure and deployment impact
- **Coordinate execution** across agents for complex tasks

### 3. **Incremental Progress**
- **Small, focused changes** that can be tested immediately
- **Add complexity gradually** - a little bit at a time
- **Test after each meaningful change**
- **Maintain working state** throughout development

### 4. **Sequential Implementation Strategy**
- **Use TodoWrite tool proactively** for multi-step features to track progress and maintain focus
- **Break complex features into logical chunks**: Discovery → Core Logic → CLI → Helper Methods
- **Complete one component fully before moving to next** - avoid partial implementations
- **Follow existing patterns and naming conventions** when extending systems

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

## Working Process

### Planning Phase
1. **Understand the actual problem** - not assumed problems
2. **Document the approach** in clear steps
3. **Get user/stakeholder agreement** before proceeding
4. **Identify which agents** are needed for the work

### Execution Phase
1. **Work incrementally** with frequent testing
2. **Coordinate agents** for their expertise areas
3. **Test and verify** at each meaningful milestone
4. **Commit progress** with descriptive messages

### Code Analysis Phase
1. **Read multiple related files in parallel** when understanding system architecture
2. **Use targeted grep searches** to find specific patterns and methods
3. **Check existing imports and dependencies** before adding new functionality
4. **Follow existing code patterns** for consistency

### Review Phase
1. **Verify all objectives** were met
2. **Document lessons learned**
3. **Update processes** based on what worked/didn't work
4. **Plan next steps** if applicable

## Agent Usage Guidelines

### When to Consult Multiple Agents
- Major architectural decisions
- Complex implementations affecting multiple areas
- Infrastructure or deployment changes
- Quality assessments and code reviews

### How to Coordinate Agents
- Start with planning/strategy (engineering-director)
- Get technical validation (fullstack-engineer)  
- Check operational impact (devops-deployment-optimizer)
- Execute with appropriate agent for the work type
- Final review with engineering-director

## Quality Standards

### Daily Standards
- Build succeeds without errors
- Tests pass
- Code is clean and readable
- Git history is clear

### Documentation Standards
- **Add comments that explain the "why" not just the "what"**
- **Reference business logic** in technical comments when relevant
- **Explain edge cases and assumptions** in complex logic
- **Document configuration dependencies** clearly

### Before Major Changes
- Backup/tag current working state
- Plan the change approach
- Get consensus on approach
- Test thoroughly before committing

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
4. **Get fresh perspective** from engineering-director

## Key Success Factors

1. **Communication**: Clear questions, documented plans, user alignment
2. **Coordination**: Proper agent consultation and consensus building  
3. **Incremental progress**: Small steps, frequent testing, working software
4. **Quality focus**: Standards maintained, technical debt managed
5. **Adaptability**: Quick pivots when priorities or understanding changes

**Philosophy**: Build the right thing, the right way, one step at a time.