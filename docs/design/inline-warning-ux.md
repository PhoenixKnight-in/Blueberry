# Inline warning UX — wireframe

## Severity states
- Safe (score < threshold, no flags): no decoration at all — silence is the signal.
- Caution (score 30–70): amber dashed underline + hover tooltip.
- High risk (score > 70): red dashed underline + hover tooltip + inline quick-fix actions.

## Hover tooltip content
- Risk score (0–100)
- Up to 2 reasons, in plain language (e.g. "not found on PyPI", "98% similarity to 'requests'")
- Actions: View details, Ignore, Open dashboard (FR-11)

## Rationale
Underline only, never a blocking popup — matches Usability NFR (SRS §4): warnings
appear inline, at the point the developer is already looking, without forcing them
out of flow.
