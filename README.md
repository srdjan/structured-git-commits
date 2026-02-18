# Structured Git Commits
<p align="center">
  <img src="assets/gitlogs.jpg" width="400" alt="Git Commit Logs - Structural Data Systems">
</p>

A complete system for turning your git history into a queryable agent memory layer without adding any external infrastructure. This repository provides two complementary skills: one for writing structured commits, and one for querying them to reconstruct context.

## Why This Exists

Git commits are already versioned, always present, and co-located with your code. This skill makes them serve double duty: human-readable change logs and machine-parseable memory that AI agents can query to reconstruct context, understand decisions, and avoid repeating work.

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

## Quick Start

### Prerequisites

>The validation and parsing scripts require [Deno](https://deno.land). The skills
>themselves (SKILL.md files and reference docs) work without Deno - they just guide
>how Claude writes and queries commit messages. Deno is only needed if you want the
>CLI tools: `deno task validate`, `deno task parse`, `deno task retrofit`, and `deno task hook:install`.

### The Two Skills

This system has two complementary skills:

1. **[git-structure-commits](skills/git-structure-commits/SKILL.md)** - Write commits that serve as agent memory with structured trailers, controlled vocabulary, and decision records
2. **[git-query-commits](skills/git-query-commits/SKILL.md)** - Query commit history to reconstruct context, understand past decisions, and avoid repeating work

Both skills work independently, but together they create a zero-infrastructure agent memory layer. The first skill ensures commits are machine-parseable, the second skill teaches agents when and how to query them.

### For Developers

When committing code, follow the format in [references/commit-format.md](skills/git-structure-commits/references/commit-format.md):

1. Write a conventional commits subject line: `type(scope): description`
2. Add a body explaining what and why
3. Include required trailers: `Intent:` and `Scope:`
4. Record alternatives you considered: `Decided-Against:`

The intent must be one of eight values from the [controlled vocabulary](skills/git-structure-commits/references/intent-taxonomy.md): `enable-capability`, `fix-defect`, `improve-quality`, `restructure`, `configure-infra`, `document`, `explore`, or `resolve-blocker`.

### For AI Agents

These are Claude Code skills. When installed globally at `~/.claude/skills/`, Claude will automatically:
- Use the structured format when creating commits (via git-structure-commits skill)
- Know when and how to query commit history for context (via git-query-commits skill)

For detailed guidance on querying commit history, see [skills/git-query-commits/SKILL.md](skills/git-query-commits/SKILL.md).

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

A Deno utility for richer parsing is available at [scripts/parse-commits.ts](scripts/parse-commits.ts).

Run it with `deno task parse` (see [deno.json](deno.json) for all tasks).

### Retrofitting Existing Commits

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

## The `Decided-Against` Trailer

This is the highest-value trailer for agent memory. When you evaluate alternatives and pick one, record what you rejected and why:

```
Decided-Against: OAuth2 client credentials (no hardware binding guarantee)
Decided-Against: longer timeout window (masks upstream latency issues)
```

Without this, the next agent working in the same area will waste time re-evaluating the same options. With it, they can query your reasoning and build on your decisions instead of repeating them.

## Examples

See [skills/git-structure-commits/SKILL.md](skills/git-structure-commits/SKILL.md) for complete examples covering:
- Simple feature additions
- Bug fixes with decision context
- Architectural refactors
- Exploratory spikes
- Infrastructure configuration

## Customization

The format, taxonomy, and tooling are designed to be forked and adapted. The
intent vocabulary, known trailer keys, and validation rules are all defined in
plain TypeScript with no external dependencies. If your project needs different
intents, additional trailers, or looser validation, edit `scripts/types.ts` and
`scripts/lib/validator.ts` directly. The taxonomy is intentionally small so
that changes are easy to reason about.

## Installation

### Global Installation (All Projects)

Install one or both skills to your Claude skills directory:

```bash
# Install both skills (recommended)
cp -r skills/* ~/.claude/skills/

# Or install individually
mkdir -p ~/.claude/skills
cp -r skills/git-structure-commits ~/.claude/skills/
cp -r skills/git-query-commits ~/.claude/skills/
```

Claude Code will now use the structured commit format automatically and know when to query git history for context.

### Git Commit-Msg Hook

Install the validation hook to enforce the format on every commit:

```bash
# Local (current repo only)
deno task hook:install

# Global (all repos)
deno task hook:install --global

# Remove
deno task hook:install --uninstall
```

The hook validates commit messages and rejects those with errors (missing Intent, invalid format, etc.) while allowing warnings to pass.

### Commit Template

Install the commit template to get format guidance in your editor:

```bash
git config commit.template path/to/templates/.gitmessage
```

### Session Auto-Population

To avoid manually typing Session IDs across related commits, set an
environment variable and use a prepare-commit-msg hook:

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

### Claude Code Hook (Auto-Context)

A `UserPromptSubmit` hook can inject recent git history context before every Claude prompt automatically. This implements the RLM pattern: Claude receives a compact summary of recent commits, decisions, and session info without having to actively query.

**What it does:** On every prompt, the hook runs `scripts/git-memory-context.ts`, which loads the trailer index (or falls back to git log) and outputs a `<git-memory-context>` block that Claude sees as injected context. This includes recent decided-against entries, recent commit subjects with scopes, and current session info.

**Installation:**

1. The hook configuration lives in `.claude/settings.json` (already included in this repository):

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

2. Add the `<git-memory>` instructions from `CLAUDE.md` to your project's CLAUDE.md so Claude knows how to use the injected context and when to query deeper.

3. Verify it works by running manually:

```bash
deno task context
```

This should produce a `<git-memory-context>` block with recent commits and decisions. In a live Claude Code session, this output is automatically injected before Claude processes each prompt.

### Project-Specific Installation

Add this repository as a git submodule or copy the files into your project's documentation. Reference the format in your CONTRIBUTING.md or development guidelines.

## Performance

Two optional optimizations accelerate queries as repositories grow:

- **Commit-graph** (`deno task graph:write`): Writes a binary acceleration structure with changed-paths Bloom filters, speeding up path-based queries (`--path=`) by 2-30x and enabling fast ancestry checks via `--since-commit=HASH`. Does not speed up `--grep` searches.
- **Trailer index** (`deno task index:build`): Builds an inverted index of trailer values to commit hashes at `.git/info/trailer-index.json`, making intent/scope/session/decided-against lookups O(1) instead of O(n) grep scans.

Run both at once with `deno task optimize`. See [references/performance.md](skills/git-query-commits/references/performance.md) for details.

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
