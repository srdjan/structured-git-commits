---
name: git-query-commits
description: Proactively query structured git commit history to reconstruct context, understand past decisions, and avoid repeating work
---

# Git Memory Query

## Purpose

Git history is the most reliable source of truth about why code exists in its current form. This skill guides agents to proactively query commit history before making changes, preventing wasted effort re-evaluating decisions that were already made and documented.

When commits follow structured formats (especially git-structure-commits), git becomes a queryable decision database. Even without structured commits, git history remains valuable for understanding context, but structured commits enable semantic queries by intent, scope, and explicit decision records.

## When to Use

Query git history BEFORE starting work when:

- Implementing a feature in an unfamiliar module or codebase area
- Debugging a complex issue with unclear root cause
- Refactoring or restructuring existing code
- Choosing between multiple implementation approaches
- Understanding why code is structured in a particular way
- Evaluating whether to revert or modify existing behavior
- Working in code that has been modified frequently
- Resuming work on a feature after time away

Do NOT query history for:

- Trivial changes like typo fixes or formatting
- Brand new codebases with minimal history
- Cases where the user has already provided complete context
- Simple, well-understood changes that don't touch existing logic

## Query Patterns by Scenario

### Scenario 1: Stuck on a Bug

You are debugging an issue and the root cause is unclear. Git history can reveal if this was a known issue, if similar bugs were fixed before, or if recent changes introduced the problem.

**Query strategy:**

1. Search for recent fixes in the same module
2. Look for commits mentioning the same error message or symptom
3. Check if this was a known issue that was resolved before

```bash
# Find recent fixes in this module
git log --format='%h %s' --grep='Intent: fix-defect' --since='3 months ago' -- path/to/module

# Search for error message or symptom in commit messages
git log --format='%H %s' --grep='TypeError.*undefined' --since='6 months ago'

# Search for changes that touched specific code
git log -S 'function calculateTotal' -- path/to/module

# Get full context for a promising commit
git show <commit-hash>
```

**For structured commits:**

```bash
# Use parse-commits for rich filtering
deno task parse --scope=orders/pricing --intent=fix-defect --limit=10 --with-body
```

### Scenario 2: Choosing an Implementation Approach

You have multiple ways to implement a feature and need to decide. Git history reveals what has been tried before, what alternatives were rejected, and why.

**Query strategy:**

1. Check if similar approaches were tried before
2. Look for `Decided-Against` trailers in related areas
3. Understand the architectural patterns already established

```bash
# Did anyone try approach X before?
git log --format='%B' --grep='Decided-Against' -- path/to/module | grep -i 'redis'

# What patterns exist for similar features?
git log --format='%h %s' --grep='Intent: enable-capability' --grep='Scope: auth' --all-match --since='1 year ago'

# Find architectural decisions
git log --format='%B' --grep='Intent: restructure' --since='6 months ago' -- path/to/module
```

**For structured commits:**

```bash
# Decision archaeology - what was rejected and why?
deno task parse --decided-against=redis --with-body

# All capability additions in authentication
deno task parse --scope=auth --intent=enable-capability --limit=20

# Explore commits often document findings and alternatives
deno task parse --intent=explore --scope=search --with-body
```

### Scenario 3: Understanding Unfamiliar Code

You need to modify code you did not write and do not fully understand. Git history explains how the code evolved, what problems it solves, and what constraints shaped it.

**Query strategy:**

1. Find the commits that introduced this code
2. Read the commit bodies for context (the why, not just the what)
3. Check for related refactors or fixes that clarify intent

```bash
# What introduced this file?
git log --diff-filter=A --format='%H %s%n%b' -- path/to/file.ts

# Recent changes to this area
git log -10 --format='%h %ai %s' -- path/to/module

# Full history with bodies (wrap at 72 chars for readability)
git log --format='%H%n%s%n%b%n---' -- path/to/file.ts | less

# Who has worked on this code? (author perspective can guide questions)
git shortlog -sn -- path/to/module
```

**For structured commits:**

```bash
# All intents in this module
deno task parse --path=path/to/module --limit=20

# Quality improvements and restructures reveal design evolution
deno task parse --scope=orders/pricing --intent=improve-quality --intent=restructure
```

### Scenario 4: Evaluating a Revert or Rollback

You are considering reverting a change but want to understand its full impact and whether it fixed something important.

**Query strategy:**

1. Understand why the original change was made
2. Check if it fixed something critical
3. Look for follow-up commits that depend on it

```bash
# Full context for the commit to revert
git show <commit-hash>

# What came after this commit in the same area?
git log <commit-hash>..HEAD --format='%h %s' -- path/to/affected/area

# Was this commit referenced later?
git log --format='%B' --grep='<commit-hash-prefix>' --since='<commit-date>'
```

**For structured commits:**

```bash
# Find related commits by session (often group related work)
git log --format='%h %s' --grep='Session: 2025-02-08/feature-name'

# Check if this resolved a blocker
deno task parse --intent=resolve-blocker --since='<commit-date>' --limit=10
```

### Scenario 5: Reconstructing Session Context

You need to resume work on a feature after time away, or understand a sequence of related changes made by another agent or developer.

**Query strategy:**

1. Filter by session ID (if available)
2. Read commits in chronological order
3. Pay special attention to explore commits (they document findings)

```bash
# All commits from a session
git log --format='%H %s' --grep='Session: 2025-02-08/vector-search' --reverse

# Recent work in this area
git log -20 --format='%h %ai %s' -- path/to/module

# Commits by a specific author (if resuming their work)
git log --author='email@example.com' --since='1 week ago' --format='%h %s'
```

**For structured commits:**

```bash
# Full session reconstruction with bodies
deno task parse --session=2025-02-08/vector-search --with-body

# What was explored? (findings and decisions)
deno task parse --intent=explore --scope=search --since='1 week ago' --with-body

# What blockers were hit?
deno task parse --intent=resolve-blocker --scope=search --since='1 week ago'
```

## Using parse-commits.ts for Rich Queries

The parse-commits CLI (available via `deno task parse`) provides structured filtering beyond git's native capabilities. Use it when you need intent-based filtering, decision archaeology, or scope-based queries.

**Available filters:**

```bash
# Intent filtering (repeatable, OR semantics across intents)
deno task parse --intent=enable-capability
deno task parse --intent=fix-defect --intent=resolve-blocker  # Union of both

# Scope filtering (hierarchical prefix match)
# "auth" matches "auth", "auth/registration", "auth/login"
# but NOT "oauth/provider" or "unauthorized"
deno task parse --scope=auth
deno task parse --scope=orders/pricing

# Decision archaeology (word-boundary matching)
# "redis" matches "Redis pub/sub" but NOT "predis" or "redistribution"
deno task parse --decided-against=redis
deno task parse --decided-against=oauth --with-body

# Session filtering (exact match)
deno task parse --session=2025-02-08/feature-name

# Time filtering
deno task parse --since='1 week ago'
deno task parse --since='2025-01-01'

# Limit results
deno task parse --limit=10

# Include commit bodies (essential for understanding why)
deno task parse --scope=auth --intent=enable-capability --with-body --limit=5

# Output as JSON for programmatic processing
deno task parse --format=json --limit=20
```

**Common query patterns:**

```bash
# What blockers have we hit in this module?
deno task parse --scope=auth --intent=resolve-blocker

# What approaches were rejected for caching?
deno task parse --decided-against=redis --decided-against=memcached --with-body

# What was explored recently?
deno task parse --intent=explore --since='2 weeks ago' --with-body

# All quality improvements in a specific area
deno task parse --scope=orders/pricing --intent=improve-quality

# Infrastructure changes in the last month
deno task parse --intent=configure-infra --since='1 month ago'
```

**Composable query library** (`scripts/lib/query.ts`):

For programmatic use (MCP tools, agent sandboxes, RLM environments), query operations are available as composable pure functions independent of the CLI:

```typescript
import { filterByIntents, filterByScope, applyQueryFilters } from "./scripts/lib/query.ts";

// Compose filters manually
const result = filterByScope("auth")(filterByIntents(["fix-defect"])(commits));

// Or use the all-in-one composition
const result = applyQueryFilters(commits, {
  intents: ["fix-defect", "resolve-blocker"],
  scope: "auth",
  session: null,
  decisionsOnly: false,
  decidedAgainst: null,
  limit: 50,
});

// Index-based query (O(1) lookups)
import { queryIndexForHashes } from "./scripts/lib/query.ts";
const hashes = queryIndexForHashes(index, params);
```

## Performance

Two optional optimizations accelerate different query patterns. Neither is required - queries work without them - but they reduce latency as repositories grow.

**Commit-graph** accelerates path-based queries (`--path=`) via changed-paths Bloom filters and enables fast ancestry checks (`--since-commit=`). It does NOT speed up `--grep` searches, which are the primary pattern for trailer-based queries.

**Trailer index** accelerates content-based queries (`--intent=`, `--scope=`, `--session=`, `--decisions-only`) by precomputing an inverted index of trailer values to commit hashes. Lookups become O(1) instead of O(n) grep scans.

**When to enable:**

- Enable commit-graph for repositories with 500+ commits using path-based queries
- Enable trailer index for repositories with 100+ structured commits using frequent trailer queries
- Both have negligible storage cost and fast build times

**Maintenance commands:**

```bash
# Write commit-graph (path queries, ancestry checks)
deno task graph:write

# Build trailer index (intent, scope, session, decided-against queries)
deno task index:build

# Both at once
deno task optimize
```

**New query capability - ancestry boundary:**

```bash
# All commits since a known ancestor (uses generation numbers, not dates)
deno task parse -- --since-commit=abc123 --intent=fix-defect
```

**Bypassing the index:**

```bash
# Force standard git log path (for debugging or verification)
deno task parse -- --intent=fix-defect --no-index
```

See [references/performance.md](references/performance.md) for detailed scaling characteristics and freshness model.

## Integration with git-structure-commits

This skill works with any git history, but provides maximum value when commits follow the git-structure-commits format because:

- **Intent trailers** enable semantic filtering (find all fixes, all explorations, all infrastructure changes)
- **Scope trailers** enable domain-level queries (filter by module or bounded context)
- **Decided-Against trailers** prevent re-evaluating rejected approaches (highest value for decision archaeology)
- **Session trailers** group related work (essential for context reconstruction)
- **Consistent commit bodies** explain the why, not just the what (git log becomes readable documentation)

If commits are not structured, you can still query effectively using:

- File path history: `git log -- path/to/file`
- Text search in messages: `git log --grep='pattern'`
- Code search in diffs: `git log -S 'code string'`
- Author and date filtering: `git log --author='name' --since='date'`

The structured format adds semantic layers on top of these native capabilities.

## Best Practices

1. **Query before implementing, not after getting stuck.** Make it a habit to check history before writing code, especially in unfamiliar areas.

2. **Start broad, then narrow.** Begin with high-level queries (intent, scope, recent changes) then drill into specific commits when you find something relevant.

3. **Read commit bodies, not just subjects.** The subject line tells you what changed, the body tells you why it changed. The why is what you need for context.

4. **Follow session trails.** When you find a relevant commit, check its session for related work. Sessions group commits that share context.

5. **Don't over-query.** If you don't find useful context after 2-3 queries, proceed with implementation and document your own decisions. Not every problem has prior art.

6. **Share findings with the user.** When git history reveals important context, mention it: "I found that approach X was tried before and rejected because Y."

## Anti-Patterns to Avoid

- **Querying history for every trivial change.** Use judgment. Typo fixes and formatting changes don't need archaeological research.

- **Only searching by file paths.** This misses cross-cutting concerns and related decisions in other modules. Use scope and intent filtering.

- **Ignoring commit bodies and only reading subject lines.** The subject is a summary. The body contains the reasoning you need.

- **Not using parse-commits when working with structured commits.** Native git commands are powerful, but parse-commits unlocks the semantic layers.

- **Giving up after one failed query.** Try different search terms, broader scopes, or longer time windows. Context might exist but need different keywords.

- **Querying without a clear question.** Know what you're looking for: decisions about approach X, history of module Y, root cause of bug Z. Aimless browsing wastes time.

- **Forgetting to check Decided-Against trailers.** This is the highest-value information for avoiding repeated work, yet often overlooked.
