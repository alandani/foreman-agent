# foreman-agent

A safety-first, multi-bot agent app. Chat is the main way to work with it, like any agent app: talk to a bot, watch it use tools, approve risky steps. Bigger jobs can also be assigned as cards on a board. Bots work inside fenced-off project folders, and nothing risky happens without a plan you can read and approve.

**Status: design done, scaffold started.** The first piece of code is the gateway's project-root path check. Everything else is still design.

## The idea

- **Chat first, board second.** Chat is the main interface: you talk to a bot and it works in a run you can follow. Longer jobs go on a board as cards, and the same loop and gateway serve both.
- **Foreman model for cards.** The owner moves a card to Ready. Bots work it in their own git worktree and move it to Review, never to Done. Only the owner closes a card.
- **One gateway for every tool call.** Schema, grant, project-root, risk, approval, credentials and logging are checked in code, in a fixed order. The model proposes; the gateway decides.
- **Contained execution.** Shell and test commands run in a container that mounts only the run's worktree. No credentials inside, network off by default.
- **Plan, then apply.** Anything that touches the outside world is split into a read-only plan and an approved apply.
- **Memory that stays small.** Notes are Markdown with a fixed format and size caps, loaded in tiers so context stays cheap.
- **Cost-aware by design.** Money budgets, result shaping, a stable cached prompt prefix and model tiers (local for cheap work, a stronger model where it pays).

## Design documents

Design notes live in [`docs/`](docs/):

- [`decisions.md`](docs/decisions.md): settled choices
- [`open-questions.md`](docs/open-questions.md): what is still undecided

The long-form design (main design, bot registry, agent loop, memory and context, tools and sandbox) will be exported here as Markdown.

## Planned stack

TypeScript end to end, SQLite for state, git worktrees per run, a container sandbox for shell commands, and pluggable model adapters (local LM Studio, Claude Agent SDK, Claude API).

## Inspiration

Loosely based on the concepts in [ai-agent-book](https://github.com/bojieli/ai-agent-book) and the multi-bot idea behind xAI's Grok Bot.
