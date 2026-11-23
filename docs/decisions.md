# Decisions

Settled choices for the design phase. Each is open to revision only with a written reason.

| Area | Decision |
| --- | --- |
| Interface | Chat is the primary interface. The board and cards are for longer jobs. One loop and one gateway serve both. |
| Language | TypeScript for backend, UI and shared tool schemas. Python only for evals and scripts that run inside the sandbox. |
| Isolation | `project_id` is the only isolation boundary. A confidential flag is deferred. |
| Lessons | Every lesson goes to owner review, with evidence (run, events, scope, last-verified). |
| Skills | Design notes only for now; no skill runtime yet. |
| Board | Only the owner moves a card to Ready or Done. Bots move cards to Review. |
| Tool calls | One mandatory gateway with a fixed order of checks. A reviewer model from a different family may flag or block, never approve. |
| Risk levels | Safe, Contained, External, Destructive. Plan-then-apply for External and Destructive work. |
| Sandbox | Container with only the run's worktree mounted, resource limits, network off by default, no credentials inside. A microVM is a later level. |
| MCP | Not in stage 1. The safety layer comes first; MCP servers are wrapped through the gateway in stage 2, one read-only server first. |
| Memory | Markdown notes in their own git repo, fixed front matter and size caps, tiered loading, search by filter then BM25 then hybrid. |
| Instructions | Bot instruction bodies use a fixed layout (Role, Principles, Procedure, Never, Output) with a size cap of about 60 lines. |
| Cost | Token and cost control is a first-class goal: result shaping, model tiers, money budgets, cache-friendly prompts. |
| Evidence | A run may finish as done only by citing event numbers for each acceptance check; tests changed by the run do not count as proof. |
