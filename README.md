# Structured Git Commits

Turn your git history into a queryable agent memory layer without adding any external infrastructure.

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

### For Developers

When committing code, follow the format in [references/commit-format.md](references/commit-format.md):

1. Write a conventional commits subject line: `type(scope): description`
2. Add a body explaining what and why
3. Include required trailers: `Intent:` and `Scope:`
4. Record alternatives you considered: `Decided-Against:`

The intent must be one of eight values from the [controlled vocabulary](references/intent-taxonomy.md): `enable-capability`, `fix-defect`, `improve-quality`, `restructure`, `configure-infra`, `document`, `explore`, or `resolve-blocker`.

### For AI Agents

This is a Claude Code skill. When installed globally at `~/.claude/skills/structured-git-commits/`, Claude will automatically use this format when creating commits during coding sessions.

To reconstruct context from commit history:

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

See [references/intent-taxonomy.md](references/intent-taxonomy.md) for detailed definitions and usage guidance.

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

See [SKILL.md](SKILL.md) for complete examples covering:
- Simple feature additions
- Bug fixes with decision context
- Architectural refactors
- Exploratory spikes
- Infrastructure configuration

## Installation

### Global Installation (All Projects)

Copy this skill to your Claude skills directory:

```bash
mkdir -p ~/.claude/skills/structured-git-commits
cp -r . ~/.claude/skills/structured-git-commits/
```

Claude Code will now use this format automatically when creating commits.

### Project-Specific Installation

Add this repository as a git submodule or copy the files into your project's documentation. Reference the format in your CONTRIBUTING.md or development guidelines.

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
