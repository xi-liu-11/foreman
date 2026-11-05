# Handoff: T0001

## Summary
Cards collapse to one line and gates show a Decision block. Activity stays separate & readable.

- **Collapsed** rows with `localStorage` state
- Decision built by `src/decision.ts`

## Risk
Low. A "quoted" <script>alert('xss')</script> & ampersand should show literally.

## Follow-ups
- Strip table pipes in findings
- Restart taskd
