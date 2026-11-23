# Open questions

- **Agent SDK as a model call.** Can the Claude Agent SDK subscription route be used as a single model call, or only as its own inner loop? Needs a short spike.
- **Container technology** on the Mac mini: Docker, Apple's container tooling or a small VM. Measure startup time and whether limits can be enforced.
- **Vault location:** system keychain or an encrypted file, and how the team version will share it.
- **Memory repo:** where it lives, who can access it, how it is backed up.
- **Local embedding model** for hybrid memory search.
- **Workspace notes:** should a solo owner's workspace notes be direct writes instead of going to `pending/`?
- **Verifier model:** is one needed in addition to the rule-based evidence check?
- **Reviewer model:** which family, how often, cost per approval.
- **Standing approvals:** needed for solo use, or is approving each push fine?
- **Book chapter 5** (coding agent and general agent) has not been compared with the Coder tools and sandbox design.
- **Thresholds to tune from real runs:** 90-day stale notes, 10-note write limit, 1,500-token index cap, 70% / 40% compaction, 60-line instruction cap, 15-tool bot cap, 30-minute plan expiry, three-denial stop.
