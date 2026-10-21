# ClaimFlow collaboration rules

ClaimFlow was built with a two-role AI-assisted workflow. Claude Code implemented the changes in this repository; Codex independently inspected the code, planned increments, and reviewed the results without editing application files; and the human owner kept authority over deployment and every AWS write (and over commits and pushes). The separation is a working process, not an assurance: it does not replace automated tests, manual verification, or human judgment, and an agent's report is not verification on its own. The rules below keep the roles distinct.

Apply to both Codex and Claude Code. Minimize total token use and rework, not just response length.

## Codex operating limits

- Default to review only. Produce implementation prompts only when the user explicitly requests one; a completion report alone is not a request.
- Reviews: at most 100 words. Implementation prompts: at most 150 words. Exceed only when the user requests detail or essential findings require it; explain briefly.
- Before proposing work, identify the observed repository gap and the concrete outcome it enables. If evidence is insufficient, inspect narrowly rather than guess.
- Before requesting broad checks, state the specific change or integration risk that requires them. Otherwise use focused checks.
- Before sending, remove repeated standing rules, speculative tasks, and details recoverable from the diff. Check the applicable word limit.
- If these limits are violated, correct the response before continuing implementation planning. Do not generate more work to compensate.
- These are behavioral instructions, not an automated enforcement mechanism or a guarantee against mistakes.

## Boundaries

- Codex reads, plans, and reviews; Claude alone edits application repository files.
- No commits, pushes, deployments, or AWS writes without explicit user authorization. AWS writes remain the user's responsibility. Necessary Codex AWS inspection uses codex-readonly.
- Preserve approved architecture, cost/scope limits, local behavior, deferrals, and unrelated uncommitted work.

## Work

- Read these rules once per chat. Inspect targeted diffs/files; do not repeatedly explore or reread whole files.
- Choose the smallest coherent working outcome, not one method per prompt. Add abstractions only for demonstrated needs.
- Prompts contain the outcome, non-obvious acceptance criteria, and validation scope. Reference standing instructions; do not repeat them or prescribe details already clear from code.
- Review actual changes and concrete risks. State inspection limits and distinguish reported checks from checks personally run.
- Propose further work only when repository evidence establishes its need. Do not automatically invent or issue another implementation prompt.
- Keep responses brief. Omit routine narration, recaps, repeated test totals, file lists, and unchanged restrictions. Report findings, failures, blockers, and material deviations.
- Own planning mistakes; do not blame the implementing agent for following the prompt.

## Validation

- Documentation: inspect text; formatting only if required.
- Contained code change: affected tests and applicable type/lint/format checks.
- Full checks/build: integration milestones or changes whose impact warrants them. Do not repeat passing checks on an unchanged tree.
- Dependency audit: dependency changes or release preparation.
- Mandatory repository checks and explicit user requirements take precedence. Explain costly exceptions briefly.

## Handoff

- Keep changing status separate: completed outcome, actual validation, open findings, and next justified outcome.
- Root AGENTS.md must reference this document so future chats discover it; do not assume chat memory persists.
