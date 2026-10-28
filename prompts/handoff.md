Write the handoff for this feature to `specs/{{FEATURE}}/handoff.md` and commit it. It is read by non-developers as well as by the user, and it becomes the pull request body or the merge commit message. Sections, in this order:

## Summary
One or two plain-language sentences: what changed from the user's point of view. Say "the catch now shows the photo's real date", not which column or function was added.

## To verify
Numbered steps a tester follows, in end-user terms. If verifying needs a new build or deployment, say so in the first line. Mention anything the tester must set up first.

## Changes
What changed technically, briefly, with links to the QA reports under `specs/{{FEATURE}}/qa/`.

## Risk
low, medium, or high, with the reasoning.

## Follow-ups
Anything out of scope that was found, with ticket references if you filed any.

Do not push, open a PR, or merge; the scheduler does that.
{{TICKET_HANDOFF}}
