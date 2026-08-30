# Dashboard information architecture

## Layout
- Left rail: filters — severity, date checked, source repository (secondary user cares
  about the aggregate picture across a codebase, per SRS §2 User Characteristics).
- Main list: one row per flagged package — name, risk score badge.
- Detail panel: opens on row click — full reason breakdown, matches the "explainable,
  not opaque" NFR (SRS §4).

## Why this shape
The secondary user (team lead / instructor) may not be actively coding when they check
the dashboard, so it must stand alone without editor context — hence a full list +
filter + detail flow rather than something that assumes an open file.
