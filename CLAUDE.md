<git-memory>
  Git memory context is automatically injected before every prompt via a
  UserPromptSubmit hook. It provides recent commits, decisions, and session info.

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
