# ClaimFlow agent instructions

Read [docs/collaboration-playbook.md](docs/collaboration-playbook.md) once per chat before working. It defines the roles, limits and validation rules; this file does not repeat them.

Essential boundaries:

- Codex reads, plans and reviews. Claude alone edits application repository files.
- No commits, pushes, merges or deployments without explicit user authorization. AWS writes are the owner's responsibility; Codex AWS inspection uses `codex-readonly`.
- Preserve approved architecture, cost and scope limits, local behavior, deferrals and unrelated uncommitted work.
- Do not add dependencies, or change API contracts or backend behavior, unless asked.
