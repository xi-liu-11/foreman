This project does not use Spec Kit. This checkout is a dedicated worktree on branch `{{FEATURE}}`-style naming; the feature directory `specs/{{FEATURE}}/` already exists.

Write `specs/{{FEATURE}}/spec.md` (goal, scope, acceptance scenarios, out of scope) and `specs/{{FEATURE}}/plan.md` (approach, files to touch in order, verification per slice, risks). Then write `specs/{{FEATURE}}/tasks.md` as a checklist of small, ordered tasks using `- [ ]` items; mark tasks that touch disjoint files with `[P]` so the developer can run them in parallel. Commit all three.
