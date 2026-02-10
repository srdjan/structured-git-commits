<git-memory>
  Git memory context is automatically injected before every prompt via a
  UserPromptSubmit hook. It reads your prompt and produces context in one
  of three modes:

  - llm-enhanced: uses a local LLM for smart prompt analysis, recursive
    follow-up queries, and context summarization (requires Ollama + config)
  - prompt-aware: keyword-based scope/intent extraction from the prompt
    (requires trailer index)
  - recency: falls back to the N most recent commits when no signals match

  The mode is indicated in the XML tag: mode="llm-enhanced", "prompt-aware",
  or "recency".

  Use this context to:
  - Avoid re-evaluating approaches listed in decided-against entries
  - Understand recent changes before proposing modifications
  - Maintain continuity with the current session's work

  Query deeper when:
  - The injected context mentions relevant scopes or decisions for the current task
  - You are about to choose between implementation approaches
  - You are modifying code in an unfamiliar area
  - The user asks about past decisions or history

  Deep query commands:
    deno task parse -- --scope=<scope> --with-body --limit=5
    deno task parse -- --decided-against=<keyword> --with-body
    deno task parse -- --session=<id> --with-body
    deno task parse -- --intent=fix-defect --scope=<scope> --limit=10
</git-memory>

<working-memory>
  Working memory persists findings, decisions, and context across prompts
  within a single session. It is stored at .git/info/working-memory.json
  and scoped to STRUCTURED_GIT_SESSION.

  When to write:
  - Findings from git history exploration (patterns, constraints, quirks)
  - Architectural decisions made during the session
  - Hypotheses about root causes or design trade-offs
  - Context from external sources relevant to the current task
  - TODOs discovered during implementation

  How to write:
    deno task memory:write -- --tag=finding --scope=auth/login --text="JWT uses sliding window" --source=abc1234
    deno task memory:write -- --tag=decision --scope=cache --text="Use Redis for session store"
    deno task memory:write -- --tag=hypothesis --text="Token refresh may race with concurrent requests"
    deno task memory:write -- --tag=todo --scope=auth --text="Add refresh token endpoint"

  Tags: finding, hypothesis, decision, context, todo
  Clear: deno task memory:clear

  Working memory is automatically injected as a <working-memory> block
  alongside the git context. Do not over-record - save only discoveries
  and decisions that matter for the remainder of the session.
</working-memory>

<git-memory-bridge>
  After git queries (deno task parse), a PostToolUse hook may inject
  related context as a <git-memory-bridge> block. This surfaces:

  - Decided-against entries in the queried scope that your query didn't show
  - Sibling scopes with the same intent (related areas of the codebase)

  The bridge runs async and arrives on the next turn. Use the surfaced
  context to inform your next action - check if a decided-against entry
  conflicts with your approach, or explore a sibling scope for patterns.
</git-memory-bridge>

<memory-consolidation>
  Working memory is automatically consolidated when a session ends via
  a Stop hook. The hook writes a session summary to
  .git/info/session-summary-{slug}.md.

  Before committing, check for trailer suggestions derived from your
  working memory decisions:
    deno task memory:consolidate -- --commit-hints

  This outputs Decided-Against and Scope trailer text that you can
  include in your commit message.
</memory-consolidation>

<rlm-local-llm>
  When configured, a local LLM (Ollama) enhances git memory context:
  - Prompt analysis uses the LLM instead of keyword matching
  - Follow-up queries are generated automatically (recursive sub-calls)
  - Bridge context is summarized by the LLM

  Setup (requires Ollama installed and running):
    ollama pull qwen2.5:7b
    deno task rlm:configure -- --enable --check

  Configuration:
    deno task rlm:configure                             # show current config
    deno task rlm:configure -- --disable                # disable LLM mode
    deno task rlm:configure -- --model=llama3.2:3b      # change model
    deno task rlm:configure -- --timeout=10000          # adjust timeout (ms)
    deno task rlm:configure -- --endpoint=http://...    # custom endpoint

  Config stored at .git/info/rlm-config.json (local, not committed)

  The active mode is indicated in the git-memory-context XML tag:
  - mode="llm-enhanced": local LLM is active
  - mode="prompt-aware": keyword matching (LLM disabled or unreachable)
  - mode="recency": basic fallback (no trailer index or signals)

  Latency: adds ~1-3s to prompt processing when enabled.
  Fallback: if Ollama is unreachable, silently falls back to keyword mode.
</rlm-local-llm>
