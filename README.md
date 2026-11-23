# makefun-site, rebuilt for speed

[![make.fun bounty](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/nasubii/makefun-site-fast/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/nasubii/makefun-site-fast/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

An entry for make.fun's [site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122):
`solve.js` is a drop-in replacement for makefun-site 1.0.0 — for every case's input its
`run(input)` returns exactly the output tree makefun-site's build returns, byte for byte,
in about half the CPU time. `main.ts` is the kit's driver, unchanged.

Same semantics, faster machinery:

- Templates are compiled once per build into plain JavaScript functions, so rendering a
  page is string building and property reads instead of a walk over node objects.
- Markdown blocks are lexed and rendered in a single pass with hand-written line
  classifiers instead of a battery of regular expressions per line, and no token objects.
- Inline rendering scans for the next special character with one regex pass and escapes
  plain runs in bulk, instead of escaping character by character.
- Front matter is scanned in place — the body is one slice, never split and rejoined —
  word counts are a single pass with no match array, and a post's reading time is
  computed once and shared by its card and its page.

Verified byte-identical to the reference on the kit's practice set and on hundreds of
mutated inputs (edge-case Markdown, broken templates, drafts, refusals, slug collisions,
Unicode titles, CRLF sources).
