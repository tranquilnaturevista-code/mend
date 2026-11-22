[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/tranquilnaturevista-code/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/tranquilnaturevista-code/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend: one patch tool for every AI edit format

`mend` applies an edit that an AI model wrote to a tree of text files, in any of
the four formats models write edits in, to the specification in
[`SPEC.md`](SPEC.md) — all or nothing: every file changes, or none does.

- **unified diffs**, even with wrong line numbers: hunks are found by their
  content, nearest to the hunk's stated position, and applied in order;
- **SEARCH/REPLACE blocks**, with the path taken from the nearest line above
  the block (code fences and prose ignored);
- **V4A patches** (`*** Begin Patch` … `*** End Patch`), with anchors, a
  cursor, end-of-file chunks and `*** Move to:`;
- **JSON tool calls** (one array, or one edit object per line): `create`,
  `str_replace` and `insert`.

Matching is forgiving where the spec says so: a block is found at the first
of three tiers — exact lines, trailing whitespace ignored, then leading and
trailing whitespace ignored — so drifted whitespace and indentation still
land on the lines the model meant, and at the loosest tier the replacement
is re-indented to the file's own indentation. `--strict` matches exactly.
A block that occurs twice with no way to choose is `ambiguous`; a block
that is nowhere is `no-match`. Wrong line numbers never matter: the hunk
takes the nearest occurrence to where it claims to be.

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is the patch file, or `-`/absent to read the patch from standard
input. `--format` is `auto` (the default, detected), `unified`,
`search-replace`, `v4a` or `json`. `--check` reports what would change
without writing anything. Exit `0` lists the changed files (`A`/`D`/`M`,
`R old -> new` for a move) and `ok: <n> files`; exit `1` lists every edit
that failed and `failed: <k> of <n> edits` with nothing written; exit `2`
is a usage, missing-patch, format or parse error. Files keep their own
line break (LF or CRLF) and their final line break, unless the patch says
otherwise (`\ No newline at end of file`).

Node 22 and its standard library alone — nothing is installed. The program
is deterministic: the same check gives the same exit code, stdout and
files every run.

## Files

- `main.ts` — the CLI.
- `runner.ts` — the kit's runner, kept as it is: in a trial it reads the
  checks from the environment and runs `main.ts` on each one.
- `check.ts` — the practice set on this machine:
  `node check.ts ../hidden-spec-cli-01-run-20261122-kit/hidden-spec-cli-01-run-20261122-kit/program/generator/practice.json`
- `SPEC.md` — the whole specification.

## Practice score

100 of 100 practice checks pass (practice score **1000**), plus 65 of 65
hand-built edge cases covering sentences of the spec the practice set does
not show (malformed headers, `\ No newline at end of file`, empty-O
insertions, V4A anchors and end-of-file chunks, moves with no hunks,
`--check`, usage errors, unsafe paths).

## Bounty

Built for the [make.fun bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
"Build mend, one patch tool for every AI edit format" ($100, 10 places).
