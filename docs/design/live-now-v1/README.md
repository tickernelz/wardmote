# LIVE NOW redesign mockup v1 (ZHA-6242)

Design only. No product code changes.

- `assets/`: "before" evidence. `before-phone-*.jpg` are Zhafron's phone screenshots from ZHA-4722; `before-desktop-*.png` and `before-phone-12.png` come from a throwaway Wardmote 2026.1114.3 instance (commit 7e9514f7b6) seeded with 1, 3 and 12 running runs.
- `src/mock.py`: HTML mockup components (rows, phone frame, kanban band, state diagram). Tokens copied from `ui/src/index.css`, icons from lucide-react 1.48.0 (`src/icons.json`).
- `src/doc_a.py`, `src/doc_b.py`, `src/doc_c.py`: the 24 pages (A before, B list, C kanban, D pause and resume, E interaction, F plan and decisions).
- `src/build.py`: measures the mockups, renders `out/Wardmote-live-now-mockup-v1.pdf` with headless Chrome and fails when a page overflows, an element passes the page edge, a table cell clips, or mockup text is below WCAG AA contrast in light or dark.

Build:

~~~sh
cd docs/design/live-now-v1/src
python3 build.py
~~~

Needs Python 3 and Google Chrome. Output lands in `out/` (ignored).
