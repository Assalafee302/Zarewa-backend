# UX Standards (Bank-Grade Baseline)

This standard is the default for all high-traffic workspace pages.

## Readability

- Minimum body copy: `12px` (`text-xs`) for operational metadata.
- Avoid `text-[8px]` except print artifacts and ultra-dense badges.
- Use sentence case for descriptive text; reserve uppercase for short labels and chips.
- Keep subtitle lines readable (`z-page-subtitle`) and action oriented.

## Hierarchy

- Use [src/components/layout/PageHeader.jsx](src/components/layout/PageHeader.jsx) for all page headers.
- Header structure:
  - `eyebrow` (optional module context)
  - `title` (required, visible)
  - `subtitle` (what this page does + expected operator action)
  - `tabs` (where applicable)
  - `actions`/`toolbar` (right-aligned)

## Shared Utility Classes

Defined in [src/index.css](src/index.css):

- `z-page-title`
- `z-page-subtitle`
- `z-meta-text`
- `z-chip`
- `z-list-row-compact`

Use these instead of custom one-off text sizes for dashboard, sales, finance, and management pages.

## List and Queue Patterns

- Row containers should use a consistent compact style (`z-list-row-compact`) with:
  - primary id/name line
  - one concise metadata line
  - clear status chips
  - explicit primary action
- Empty states must include:
  - plain-language status
  - immediate next action

## Controls and Labels

- Primary action: one dominant button per section.
- Secondary actions: border-only or muted style.
- Status chips should use semantic colors consistently:
  - Green = complete/approved
  - Amber = pending/review
  - Red = blocked/rejected
  - Slate = neutral/informational

## Accessibility

- Maintain keyboard focus states on all interactive controls.
- Keep action labels explicit (`Approve`, `Record payout`, `Review`) instead of ambiguous verbs.
- Ensure title and subtitle explain page purpose without relying on color.
