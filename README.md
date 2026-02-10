# Structured Git Commits
<p align="center">
  <img src="assets/gitlogs.jpg" width="400" alt="Git Commit Logs - Structural Data Systems">
</p>

A complete system for turning your git history into a queryable agent memory layer without adding any external infrastructure. This repository provides two complementary skills: one for writing structured commits, and one for querying them to reconstruct context.

## Table of Contents

- [Why This Exists](#why-this-exists)
- [What You Get](#what-you-get)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Claude Code Hooks (RLM Pattern)](#claude-code-hooks-rlm-pattern)
- [Retrofitting Existing Commits](#retrofitting-existing-commits)
- [Intent Taxonomy](#intent-taxonomy)
- [Trailer Reference](#trailer-reference)
- [Performance](#performance)
- [Customization](#customization)
- [Design Philosophy](#design-philosophy)
- [Anti-Patterns to Avoid](#anti-patterns-to-avoid)
- [License](#license)
- [Contributing](#contributing)

## Why This Exists

Git commits are already versioned, always present, and co-located with your code. This system makes them serve double duty: human-readable change logs and machine-parseable memory that AI agents can query to reconstruct context, understand decisions, and avoid repeating work.

Every commit includes structured trailers from a controlled vocabulary, making your git log semantically searchable. When an agent asks "why did we choose this approach?" or "what alternatives were considered?", the answers live in your commit history.

## What You Get

Standard commits tell you *what* changed. Structured commits tell you *why* it changed, *what alternatives were rejected*, and *what intent motivated it*. This turns `git log` into a decision archaeology tool.

Compare a standard commit:

```
feat: add user authentication
```

To a structured commit:

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

The second commit is machine-queryable. An agent can search for all `enable-capability` commits, filter by scope, or find every decision made about authentication alternatives.

## Installation

### Automated (Recommended)

The fastest way to add the full system to an existing project:

```bash
# Install into your project
deno task rlm:install -- --target=/path/to/your/project

# Preview what will be changed
deno task rlm:install -- --target=/path/to/your/project --dry-run

# Remove from a project
deno task rlm:install -- --target=/path/to/your/project --uninstall
```

This copies 16 script files, merges 3 Claude Code hook definitions into `.claude/settings.json`, injects 5 instruction sections into `CLAUDE.md`, and adds 5 deno tasks to `deno.json`. The target must be a git repository with `deno` available on PATH.

The script is idempotent: running it again upgrades in place without duplicating entries. Use `--skip-hooks` if the target project manages `.claude/settings.json` separately.

After installing, start a Claude Code session in the target project. The hooks begin injecting context automatically. For optional local LLM enhancement, run `deno task rlm:configure -- --enable --check` in the target.

### Manual

If you prefer granular control, install components individually.

**Claude Code skills** (teaches Claude the commit format and query patterns):

```bash
# Install both skills (recommended)
cp -r skills/* ~/.claude/skills/

# Or install individually
mkdir -p ~/.claude/skills
cp -r skills/git-structure-commits ~/.claude/skills/
cp -r skills/git-query-commits ~/.claude/skills/
```

**Git commit-msg hook** (validates commit messages on every commit):

```bash
# Local (current repo only)
deno task hook:install

# Global (all repos)
deno task hook:install --global

# Remove
deno task hook:install --uninstall
```

The hook rejects commits with errors (missing Intent, invalid format, etc.) while allowing warnings to pass.

**Commit template** (format guidance in your editor):

```bash
git config commit.template path/to/templates/.gitmessage
```

**Session auto-population** (avoids manually typing Session IDs):

```bash
export STRUCTURED_GIT_SESSION="2025-02-08/my-feature"
```

Add a prepare-commit-msg hook that auto-fills the trailer:

```bash
#!/bin/sh
if [ -n "$STRUCTURED_GIT_SESSION" ]; then
  if ! grep -q "^Session:" "$1"; then
    echo "" >> "$1"
    echo "Session: $STRUCTURED_GIT_SESSION" >> "$1"
  fi
fi
```

### Prerequisites

The validation and parsing scripts require [Deno](https://deno.land). The skills themselves (SKILL.md files and reference docs) work without Deno - they just guide how Claude writes and queries commit messages. Deno is only needed if you want the CLI tools: `deno task validate`, `deno task parse`, `deno task retrofit`, `deno task hook:install`, `deno task rlm:configure`, and the memory utilities (`deno task memory:write`, `memory:clear`, `memory:consolidate`).

## Quick Start

For a comprehensive walkthrough, see the [User Guide](GUIDE.md).

### The Two Skills

This system has two complementary skills:

1. **[git-structure-commits](skills/git-structure-commits/SKILL.md)** - Write commits that serve as agent memory with structured trailers, controlled vocabulary, and decision records
2. **[git-query-commits](skills/git-query-commits/SKILL.md)** - Query commit history to reconstruct context, understand past decisions, and avoid repeating work

Both skills work independently, but together they create a zero-infrastructure agent memory layer. The first skill ensures commits are machine-parseable, the second skill teaches agents when and how to query them.

### Writing Commits

When committing code, follow the format in [references/commit-format.md](skills/git-structure-commits/references/commit-format.md):

1. Write a conventional commits subject line: `type(scope): description`
2. Add a body explaining what and why
3. Include required trailers: `Intent:` and `Scope:`
4. Record alternatives you considered: `Decided-Against:`

The intent must be one of eight values from the [controlled vocabulary](skills/git-structure-commits/references/intent-taxonomy.md): `enable-capability`, `fix-defect`, `improve-quality`, `restructure`, `configure-infra`, `document`, `explore`, or `resolve-blocker`.

### Querying Commits

Quick reference for reconstructing context from commit history:

```bash
# Find all commits from a specific session
git log --format='%H %s' --grep='Session: 2025-02-08'

# Find decisions about a specific module
git log --format='%B' --grep='Decided-Against' -- path/to/module

# Filter by intent
git log --format='%H %s' --grep='Intent: enable-capability' --since='1 week ago'

# Parse structured trailers
git log -1 --format='%(trailers:key=Intent,valueonly)' <commit-hash>
```

A Deno utility for richer parsing is available at [scripts/parse-commits.ts](scripts/parse-commits.ts). Run it with `deno task parse` (see [deno.json](deno.json) for all tasks).

For detailed guidance on querying commit history, see [skills/git-query-commits/SKILL.md](skills/git-query-commits/SKILL.md).

## Claude Code Hooks (RLM Pattern)

Three hooks implement the full Read-Log-Memory pattern, giving Claude automatic access to git history context without active querying. These are installed automatically by `deno task rlm:install`, or can be configured manually.

**UserPromptSubmit** - injects git history context before every prompt. Operates in three modes:
- *llm-enhanced*: uses a local LLM (Ollama) for smart prompt analysis, recursive follow-up queries, and context summarization
- *prompt-aware*: keyword-based extraction of scopes and intents from the prompt, matched against the trailer index
- *recency*: falls back to the N most recent commits when no signals match

Also injects working memory (session-scoped findings, decisions, and hypotheses persisted across prompts).

**PostToolUse** - bridge hook that fires after `deno task parse` queries. Surfaces related decided-against entries and sibling scopes the query did not directly ask for. When LLM mode is enabled, the heuristic output is summarized by the local model.

**Stop** - consolidates working memory into a session summary when a session ends. Writes to `.git/info/session-summary-{slug}.md`.

### Manual Hook Configuration

The hook configuration lives in `.claude/settings.json` (already included in this repository):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "deno run --allow-run --allow-read --allow-env --allow-net scripts/git-memory-context.ts"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "deno run --allow-run --allow-read --allow-env --allow-net scripts/git-memory-bridge.ts",
            "async": true
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "deno run --allow-run --allow-read --allow-write --allow-env scripts/git-memory-consolidate.ts"
          }
        ]
      }
    ]
  }
}
```

Add the instructions from `CLAUDE.md` (git-memory, working-memory, git-memory-bridge, memory-consolidation, rlm-local-llm sections) to your project's CLAUDE.md so Claude knows how to use the injected context.

Verify the hooks work by running:

```bash
deno task context
```

This should produce a `<git-memory-context>` block with recent commits and decisions. In a live Claude Code session, this output is automatically injected before Claude processes each prompt.

### Local LLM Mode

Enable Ollama-powered prompt analysis and recursive sub-calls for richer context extraction:

```bash
# Enable and test connectivity
deno task rlm:configure -- --enable --check

# Disable
deno task rlm:configure -- --disable
```

Config is stored at `.git/info/rlm-config.json` (not committed). Adds ~1-3s latency per prompt. Falls back silently to keyword mode if Ollama is unreachable.

### Working Memory

Persist findings and decisions within a session:

```bash
# Persist a finding or decision
deno task memory:write -- --tag=finding --scope=auth --text="JWT uses sliding window"

# Clear working memory
deno task memory:clear

# Generate commit trailer hints from session decisions
deno task memory:consolidate -- --commit-hints
```

## Retrofitting Existing Commits

If you have an existing repository with unstructured commits, the retrofit utility generates structured commit messages using Claude:

```bash
# Preview what will be processed (no API calls)
deno task retrofit -- --dry-run --limit=10

# Generate structured messages for the last 20 commits
deno task retrofit -- --limit=20 --output=retrofit-report.md

# Resume a previous run (skips cached commits)
deno task retrofit -- --resume --output=retrofit-report.md

# Rewrite git history with validated messages (destructive - creates backup refs)
deno task retrofit -- --apply
```

The utility extracts each commit's message, diff stats, and shortstat, sends them to Claude with the format spec and intent taxonomy as system context, validates the generated messages against the same rules as the commit-msg hook, and retries on validation errors. Results are cached to `.retrofit-cache.json` for resume support.

The `--apply` flag rewrites history using `git filter-branch`. Only commits with zero validation errors are rewritten. Original refs are saved to `refs/original/` for recovery. Requires `ANTHROPIC_API_KEY` environment variable.

## Intent Taxonomy

Every commit must include exactly one intent from this vocabulary:

| Intent | Use When |
|--------|----------|
| `enable-capability` | Adding new user-facing or system capability |
| `fix-defect` | Correcting incorrect behavior |
| `improve-quality` | Non-functional improvement (performance, readability, resilience) |
| `restructure` | Architectural change, module extraction, code movement |
| `configure-infra` | Tooling, CI/CD, dependencies, build system |
| `document` | Documentation, ADRs, comments, API docs |
| `explore` | Spike, prototype, hypothesis validation |
| `resolve-blocker` | Unblocking a dependent task or workflow |

See [references/intent-taxonomy.md](skills/git-structure-commits/references/intent-taxonomy.md) for detailed definitions and usage guidance.

## Trailer Reference

Required trailers:
- **Intent**: One value from the taxonomy above
- **Scope**: Comma-separated domain paths (e.g., `auth/registration, api/middleware`)

Optional but highly valuable:
- **Decided-Against**: Alternatives you considered and rejected, with reasons
- **Session**: ISO date + slug to group related commits (e.g., `2025-02-08/passkey-lib`)
- **Refs**: Related commits, issues, or docs (e.g., `abc123f, #1847`)
- **Context**: Compact single-line JSON for structured metadata

### The `Decided-Against` Trailer

This is the highest-value trailer for agent memory. When you evaluate alternatives and pick one, record what you rejected and why:

```
Decided-Against: OAuth2 client credentials (no hardware binding guarantee)
Decided-Against: longer timeout window (masks upstream latency issues)
```

Without this, the next agent working in the same area will waste time re-evaluating the same options. With it, they can query your reasoning and build on your decisions instead of repeating them.

## Performance

Two optional optimizations accelerate queries as repositories grow:

- **Commit-graph** (`deno task graph:write`): Writes a binary acceleration structure with changed-paths Bloom filters, speeding up path-based queries (`--path=`) by 2-30x and enabling fast ancestry checks via `--since-commit=HASH`. Does not speed up `--grep` searches.
- **Trailer index** (`deno task index:build`): Builds an inverted index of trailer values to commit hashes at `.git/info/trailer-index.json`, making intent/scope/session/decided-against lookups O(1) instead of O(n) grep scans.

Run both at once with `deno task optimize`. See [references/performance.md](skills/git-query-commits/references/performance.md) for details.

## Customization

The format, taxonomy, and tooling are designed to be forked and adapted. The
intent vocabulary, known trailer keys, and validation rules are all defined in
plain TypeScript with no external dependencies. If your project needs different
intents, additional trailers, or looser validation, edit `scripts/types.ts` and
`scripts/lib/validator.ts` directly. The taxonomy is intentionally small so
that changes are easy to reason about.

## Examples

See [skills/git-structure-commits/SKILL.md](skills/git-structure-commits/SKILL.md) for complete examples covering:
- Simple feature additions
- Bug fixes with decision context
- Architectural refactors
- Exploratory spikes
- Infrastructure configuration

## Design Philosophy

This system follows three principles:

1. **Git commits are the source of truth**: No external databases, no separate documentation systems. The commit history is authoritative.

2. **Human-readable, machine-parseable**: Commits remain scannable by developers while being queryable by agents. The format adds structure without sacrificing readability.

3. **Controlled vocabulary prevents drift**: The intent taxonomy is fixed and small. This makes semantic queries reliable and prevents the "tagging chaos" that emerges from freeform metadata.

## Anti-Patterns to Avoid

- Using file paths as scopes instead of domain concepts
- Including multiple intents in one commit (split the commit instead)
- Empty commit bodies (the subject line is never enough)
- Generic scopes like "backend" (be specific: `auth/session, api/middleware`)
- Omitting `Decided-Against` when you evaluated alternatives

## License

MIT

## Contributing

This format is intentionally minimal and stable. Proposals to add new intent types or trailer fields should demonstrate that:

1. The information cannot be expressed with existing trailers
2. The addition would be valuable across projects and domains
3. The vocabulary remains small enough for agents to reliably query

Open an issue to discuss before submitting PRs that change the taxonomy.
