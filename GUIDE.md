# User Guide

This guide walks you through adopting structured git commits from scratch. It covers writing commits, querying them, and setting up the tooling that turns your git history into a queryable decision database.

## What You Are Setting Up

Standard git commits record what changed. Structured commits also record why it changed, what alternatives were considered and rejected, and what strategic intent motivated the work. The result is a git log that both humans and AI agents can query semantically.

The system has three layers:

1. **A commit format** with typed trailers from a controlled vocabulary, enforced by a commit-msg hook
2. **A query CLI** that filters commits by intent, scope, session, and decision history
3. **An auto-context hook** that injects recent history into Claude Code prompts automatically

Each layer is independent. You can adopt the format without the CLI, or the CLI without the hook. But the layers compound: structured commits make queries precise, and the hook makes queries automatic.

## Prerequisites

The commit format itself requires nothing - it is just a convention for how you write messages. The CLI tooling requires [Deno](https://deno.land). The auto-context hook requires Deno and [Claude Code](https://claude.ai/claude-code).

Install Deno if you do not have it:

```bash
curl -fsSL https://deno.land/install.sh | sh
```

## Installation

Clone or fork this repository, then choose which components to install.

### The Skills (for Claude Code)

Copy the skills to your Claude skills directory so Claude uses the format automatically:

```bash
cp -r skills/* ~/.claude/skills/
```

This installs two skills: `git-structure-commits` (how to write) and `git-query-commits` (how to query). Claude Code discovers them automatically.

### The Commit-Msg Hook

Install the validation hook to reject commits that do not follow the format:

```bash
# Current repository only
deno task hook:install

# All repositories (global hook)
deno task hook:install --global

# Remove later if needed
deno task hook:install --uninstall
```

The hook runs `scripts/validate-commit.ts` on every commit message. Errors (missing Intent, invalid format) block the commit. Warnings (flat scope without `/`, empty body on a feature commit) are reported but allowed through.

### The Commit Template

Install the template for format guidance in your editor:

```bash
git config commit.template path/to/templates/.gitmessage
```

## Writing Your First Commit

A structured commit has three parts: header, body, and trailers.

```
feat(auth): add passkey registration for AI agent identities

Implement WebAuthn registration flow supporting non-human identity types.
Agent identities use deterministic key derivation instead of user gestures,
enabling automated credential provisioning during agent onboarding.

Intent: enable-capability
Scope: auth/registration, identity/agent
Decided-Against: OAuth2 client credentials (no hardware binding guarantee)
Session: 2025-02-08/passkey-lib
```

Walk through each part:

### The Header

```
<type>(<scope>): <subject>
```

The type comes from Conventional Commits: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`, or `revert`. The parenthetical scope is the narrowest module or area affected. The subject uses imperative mood ("add", not "added") and fits within 72 characters total.

### The Body

Explain what changed and why. Not how - the diff shows how. Wrap at 72 characters. For exploratory work, include results and conclusions. For bug fixes, describe the root cause.

### The Trailers

Trailers are `Key: Value` lines separated from the body by a blank line. Two are required:

**Intent** - exactly one value from the controlled vocabulary (covered in the next section). This captures the strategic motivation for the change.

**Scope** - comma-separated domain paths describing what areas are affected. Use your project's domain language, not file paths. `auth/registration` is good. `src/modules/auth/handlers/register.ts` is not.

Three more are optional but valuable:

**Decided-Against** - alternatives you considered and rejected, with reasons. This is the highest-value trailer. Format: `<approach> (<reason>)`. Multiple entries are allowed.

**Session** - an ISO date plus a slug that groups related commits: `2025-02-08/passkey-lib`. Useful for reconstructing the context of a working session later.

**Refs** - pointers to related commits, issues, or documents: `abc123f, #1847`.

Two more exist for specialized use:

**Context** - compact single-line JSON for structured metadata that does not fit in other trailers. Use sparingly.

**Breaking** - describes a breaking change when the `!` suffix in the header is not descriptive enough.

Trailers should appear in this order: Intent, Scope, Decided-Against, Breaking, Session, Refs, Context.

## Choosing the Right Intent

The intent taxonomy has eight values. Each describes a strategic motivation, not a code mechanism. A `refactor` commit might be `improve-quality` (cleaning up), `restructure` (changing boundaries), or `resolve-blocker` (refactoring to unblock something else).

### enable-capability

You are adding something new. After this commit, a user, system, or agent can do something it could not do before. This is the most common intent for `feat` commits.

### fix-defect

Something was broken and you are fixing it. There was a specific bug, regression, or behavior that did not match the specification. Security vulnerabilities count as defects.

### improve-quality

You are making existing code better without changing what it does from the user's perspective. Performance optimization, better error handling, test coverage, readability improvements. The key distinction from `restructure`: module boundaries did not change.

### restructure

You changed the architectural organization. Modules were extracted, dependencies were inverted, code was moved between bounded contexts. Behavior is preserved but structure changed at the module level.

### configure-infra

Changes to build systems, CI/CD, dependencies, tooling, or development environment. Does not affect application behavior directly.

### document

Purely documentation: ADRs, API docs, comments, guides. No code behavior change.

### explore

Investigative work: spikes, prototypes, benchmarks, hypothesis validation. The primary goal is learning, not shipping. Include results in the commit body and quantitative data in the Context trailer.

### resolve-blocker

You are making this change specifically because something else is blocked without it. The change has value only in context of enabling another task to proceed.

### When Two Intents Seem to Fit

Use these tiebreakers:

- `enable-capability` vs `improve-quality`: can users do something new? If yes, `enable-capability`.
- `improve-quality` vs `restructure`: did module boundaries change? If yes, `restructure`.
- `restructure` vs `resolve-blocker`: would you restructure anyway? If no, `resolve-blocker`.
- `fix-defect` vs `improve-quality`: is there a specific bug? If yes, `fix-defect`.
- `explore` vs `enable-capability`: might the code be thrown away? If yes, `explore`.

## Recording Decisions

The `Decided-Against` trailer is the most valuable part of this system. When you evaluate alternatives and pick one, the reasoning behind what you rejected is exactly what the next person (or agent) working in this area needs.

Without it, the next developer will spend time re-evaluating the same options you already explored. With it, they can read your reasoning and build on it.

Format each entry as a noun phrase followed by a reason in parentheses:

```
Decided-Against: Redis pub/sub (no persistence guarantee)
Decided-Against: Kafka (operational overhead disproportionate to scale)
```

Practical advice: if you evaluate alternatives during implementation, write them down immediately in a scratch note. Do not rely on memory at commit time. The decision context is freshest while you are making the decision.

Include `Decided-Against` whenever you considered a non-trivial alternative. Trivial choices (variable naming, formatting) do not need it. Strategic choices (architecture, libraries, algorithms, API design) do.

## Using Sessions

Sessions group related commits with a shared identifier:

```
Session: 2025-02-08/passkey-lib
```

The format is `YYYY-MM-DD/descriptive-slug`. Set an environment variable to auto-populate it across commits in a working session:

```bash
export STRUCTURED_GIT_SESSION="2025-02-08/passkey-lib"
```

With the prepare-commit-msg hook (see the README for setup), the Session trailer is appended automatically.

Sessions are valuable for context reconstruction. When you or an agent returns to a feature after time away, querying by session retrieves the full trail of changes, decisions, and explorations from that work period:

```bash
deno task parse -- --session=2025-02-08/passkey-lib --with-body
```

## Querying Your History

The query CLI (`deno task parse`) filters structured commits by trailer values. It sits on top of a composable query library that handles intent matching, hierarchical scope prefixes, word-boundary matching for decision keywords, and session filtering.

### Basic Queries

```bash
# Recent commits (default: last 50)
deno task parse

# Limit to 10
deno task parse -- --limit=10

# Include commit bodies (essential for understanding context)
deno task parse -- --with-body --limit=5

# Output as JSON for programmatic use
deno task parse -- --format=json --limit=20
```

### Filtering by Intent

```bash
# All bug fixes
deno task parse -- --intent=fix-defect

# All explorations (with bodies for findings)
deno task parse -- --intent=explore --with-body

# Multiple intents (OR semantics)
deno task parse -- --intent=fix-defect --intent=resolve-blocker
```

### Filtering by Scope

Scope uses hierarchical prefix matching. Querying for `auth` matches `auth`, `auth/registration`, and `auth/login` but not `oauth/provider`.

```bash
# Everything in authentication
deno task parse -- --scope=auth

# Just the pricing subdomain
deno task parse -- --scope=orders/pricing
```

### Decision Archaeology

This is the highest-value query pattern. Find what was rejected and why before making your own decisions.

```bash
# Was Redis considered before?
deno task parse -- --decided-against=redis --with-body

# All commits with any decisions
deno task parse -- --decisions-only

# Decisions about OAuth
deno task parse -- --decided-against=oauth --with-body
```

The `--decided-against` flag uses word-boundary matching: `redis` matches "Redis pub/sub" but not "predis" or "redistribution".

### Combining Filters

Filters compose with AND semantics (except multiple `--intent` values, which use OR):

```bash
# Bug fixes in the auth module
deno task parse -- --intent=fix-defect --scope=auth

# Explorations or capabilities in search
deno task parse -- --intent=explore --intent=enable-capability --scope=search

# Recent infrastructure changes
deno task parse -- --intent=configure-infra --since='1 month ago'
```

### Time and Path Filtering

```bash
# Since a specific date
deno task parse -- --since='2 weeks ago'

# Since a specific commit (uses generation numbers, not dates)
deno task parse -- --since-commit=abc123

# Changes to a specific path
deno task parse -- --path=scripts/lib
```

### Using Native Git

The CLI is a convenience layer. You can always query directly with git:

```bash
# All commits mentioning a specific intent
git log --format='%H %s' --grep='Intent: enable-capability'

# Decision archaeology
git log --format='%B' --grep='Decided-Against' -- path/to/module

# Extract a specific trailer
git log -1 --format='%(trailers:key=Intent,valueonly)' <hash>

# Intent frequency distribution
git log -50 --format='%(trailers:key=Intent,valueonly)' | sort | uniq -c | sort -rn
```

## The Auto-Context Hook

The auto-context hook implements the RLM (Retrieval-augmented Language Model) pattern: on every Claude Code prompt, a `UserPromptSubmit` hook injects a compact summary of recent git history. Claude sees recent commits, decided-against entries, and session info without having to actively query.

This creates two tiers of context:

- **Passive floor** (automatic): the hook dumps recent history regardless of what you ask. Claude sees it and judges relevance.
- **Active exploration** (agent-directed): when the passive context suggests relevant history exists, Claude runs deeper queries using `deno task parse`.

### Setup

The hook configuration is already in `.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "deno run --allow-run --allow-read --allow-env scripts/git-memory-context.ts"
          }
        ]
      }
    ]
  }
}
```

The companion instructions in `CLAUDE.md` tell Claude how to interpret the injected context and when to query deeper.

### How It Works

The hook script loads the trailer index (a precomputed inverted index at `.git/info/trailer-index.json`) for O(1) lookups. If the index is stale or missing, it falls back to parsing recent `git log` output. The script completes in about 35ms and always exits 0 - it never blocks your prompt.

The output is a `<git-memory-context>` block that Claude sees:

```
<git-memory-context>
Recent decisions (decided-against):
- [auth/registration] OAuth2 client credentials (no hardware binding guarantee)
- [api/webhooks] idempotency key at receiver (shifts burden to consumers)

Recent commits:
ee2a4ee refactor(query): extract composable query library | query/library
562d5fd feat(retrofit): add LLM-powered commit message retrofit | scripts/retrofit

Session: 2025-02-08/passkey-lib (3 commits)
</git-memory-context>
```

### Verifying It Works

Run the script manually:

```bash
deno task context
```

You should see a `<git-memory-context>` block with your recent commits and decisions. In a live Claude Code session, this output is injected automatically before Claude processes each prompt.

## Retrofitting Existing Commits

If you have a repository with conventional (or unconventional) commits, the retrofit utility generates structured messages using Claude:

```bash
# Preview what will be processed (no API calls)
deno task retrofit -- --dry-run --limit=10

# Generate structured messages for recent commits
deno task retrofit -- --limit=20 --output=retrofit-report.md

# Resume a previous run (skips cached commits)
deno task retrofit -- --resume --output=retrofit-report.md

# Rewrite git history with validated messages (destructive)
deno task retrofit -- --apply
```

The utility extracts each commit's message and diff stats, sends them to Claude with the format spec and intent taxonomy as system context, validates the response against the same rules as the commit-msg hook, and retries on validation errors. Results are cached to `.retrofit-cache.json`.

The `--apply` flag rewrites history using `git filter-branch`. Only commits with zero validation errors are rewritten. Original refs are saved to `refs/original/` for recovery. This requires the `ANTHROPIC_API_KEY` environment variable.

**Caution:** `--apply` rewrites git history. Use it only on branches that have not been shared, or coordinate with your team. The backup refs allow recovery, but prevention is better than recovery.

## Performance Optimization

Two optional acceleration structures speed up queries as your repository grows. Neither is required for correctness - queries work without them - but they reduce latency.

### Commit-Graph

Writes a binary acceleration structure with changed-paths Bloom filters. Speeds up path-based queries (`--path=`) by letting git skip commits that definitely did not touch a path. Also enables O(1) ancestry checks used by `--since-commit=`.

Does not help with `--grep` searches or trailer-based queries.

```bash
deno task graph:write     # Write/update
deno task graph:verify    # Check integrity
deno task graph:stats     # Inspect
```

Enable for repositories with 500+ commits that use path-based queries.

### Trailer Index

Builds an inverted index of trailer values to commit hashes at `.git/info/trailer-index.json`. Makes intent, scope, session, and decision lookups O(1) instead of O(n) grep scans.

The index stores the HEAD commit hash at build time. When the CLI loads it, it compares against current HEAD. If they differ, the index is stale and queries fall back to standard git log transparently.

```bash
deno task index:build     # Build/rebuild
deno task index:check     # Check freshness (exit 0 if fresh, 1 if stale)
```

Enable for repositories with 100+ structured commits that use frequent trailer queries.

### Both at Once

```bash
deno task optimize
```

## Splitting Commits

A good heuristic: if the Scope trailer would have more than three entries, the commit likely conflates multiple logical changes and should be split. Each commit should have exactly one intent. If you need two intents, that is two commits.

Similarly, if the commit body needs to explain multiple unrelated changes, it is probably doing too much. Smaller, focused commits with clear intent produce a history that is easier to query and understand.

## Scope Vocabulary

Establish your project's scope vocabulary early and use it consistently. Scopes should reflect domain concepts, not file paths:

Good scopes: `auth/registration`, `orders/pricing`, `api/webhooks`, `search/vector`

Bad scopes: `src/modules/auth`, `backend`, `various`, `misc`

Use two-level `domain/subdomain` paths. The first level is the bounded context or major area. The second level is the specific concern within it. Single-level scopes (just `auth`) are valid but produce a warning from the validator as a reminder to be more specific when possible.

## Customization

The format, taxonomy, and tooling are designed to be forked. The intent vocabulary, known trailer keys, and validation rules are defined in plain TypeScript with no external dependencies:

- Intent types: `scripts/types.ts` (the `INTENT_TYPES` array)
- Known trailers: `scripts/types.ts` (the `KNOWN_TRAILER_KEYS` set)
- Validation rules: `scripts/lib/validator.ts`
- Commit format spec: `skills/git-structure-commits/references/commit-format.md`
- Intent definitions: `skills/git-structure-commits/references/intent-taxonomy.md`

If your project needs different intents, additional trailers, or looser validation, edit these files directly. The taxonomy is intentionally small so that changes are easy to reason about.

## Anti-Patterns to Avoid

**Using file paths as scopes.** Scopes should be domain concepts that remain stable as code moves between files and directories.

**Multiple intents per commit.** If a commit has two motivations, it should be two commits. Split along intent boundaries.

**Empty commit bodies.** The subject line summarizes. The body explains. Agents need the explanation to reconstruct context.

**Omitting Decided-Against when you evaluated alternatives.** This is the most common missed opportunity. The reasoning behind rejected alternatives is exactly what prevents future duplicated effort.

**Generic scopes like "backend" or "misc".** These are unfilterable. Be specific enough that someone can query by scope and get useful results.

**Over-querying trivial changes.** Typo fixes and formatting changes do not need archaeological research. Use judgment about when history matters.

**Giving up after one failed query.** If the first search does not find what you need, try different keywords, broader scopes, or longer time windows.

## Quick Reference

### Commit Format

```
<type>(<scope>): <subject>          72 chars max, imperative mood

<body>                               What and why, wrapped at 72 chars

Intent: <intent-type>                REQUIRED
Scope: <domain/module>[, ...]        REQUIRED
Decided-Against: <alt> (<reason>)    Optional, repeatable
Session: YYYY-MM-DD/slug             Optional
Refs: hash, #issue, path             Optional
Context: {"key":"value"}             Optional, single-line JSON
```

### Intent Values

| Intent | When |
|--------|------|
| `enable-capability` | Adding new capability |
| `fix-defect` | Fixing incorrect behavior |
| `improve-quality` | Non-functional improvement |
| `restructure` | Architectural change |
| `configure-infra` | Tooling and build |
| `document` | Documentation only |
| `explore` | Spike or investigation |
| `resolve-blocker` | Unblocking a dependency |

### CLI Tasks

| Task | Purpose |
|------|---------|
| `deno task validate` | Validate a commit message |
| `deno task parse` | Query structured commits |
| `deno task retrofit` | Retrofit existing commits |
| `deno task context` | Preview auto-context output |
| `deno task hook:install` | Install commit-msg hook |
| `deno task graph:write` | Write commit-graph |
| `deno task index:build` | Build trailer index |
| `deno task optimize` | Both graph and index |

### Common Queries

```bash
deno task parse -- --intent=fix-defect --scope=auth --with-body
deno task parse -- --decided-against=redis --with-body
deno task parse -- --session=2025-02-08/feature --with-body
deno task parse -- --intent=explore --since='2 weeks ago' --with-body
```
