# Plan Review - Reviewer A, Round 1

## 1. [HIGH] Full-TLD parser configuration is unverified and the planned test cannot prove it

### What is wrong

Task S1 tells the builder to pass `tlds` inside the `LinkifyIt` constructor
options and then treats that as the full-list configuration, without either
calling the existing parser's separate full-list API or testing a TLD absent from
the default list. The repository only has linkify-it 5.0.2 installed, so the
requested 6.1.0 constructor behavior is unverified; on the installed parser,
that property is not an option and is ignored. A literal implementation is
therefore not guaranteed to meet the approved full-public-TLD requirement.

### Evidence

- The specification requires the complete list to replace the intentionally
  short built-in list: `docs/superpowers/specs/2026-09-02-comms-clickable-links-design.md:131-135`.
- It also requires explicit full-list configuration: `docs/superpowers/specs/2026-09-02-comms-clickable-links-design.md:158-167`.
- The plan's literal implementation passes `tlds` in the options object at
  `docs/superpowers/plans/2026-09-02-comms-clickable-links.md:245-252`, but
  does not call a TLD-loading method.
- The installed 5.0.2 parser recognizes only `fuzzyLink`, `fuzzyEmail`, and
  `fuzzyIP` when deciding whether its first constructor argument is options:
  `node_modules/linkify-it/index.mjs:33-43`, and initializes `__tlds__` to its
  defaults: `node_modules/linkify-it/index.mjs:339-361`.
- Its documented and implemented full-list operation is
  `LinkifyIt#tlds(list[, keepOld])`: `node_modules/linkify-it/index.mjs:586-607`.
- The repository resolves only that older transitive package today:
  `node_modules/linkify-it/package.json:1-3`; the proposed 6.1.0 package is not
  available in this checkout, so its behavior must be verified after install.

### Implication

The feature may visibly miss valid bare domains outside the default list. The
planned test is independently insufficient: its named modern domain is
`housing.museum`, which is already in the parser's built-in list
(`node_modules/linkify-it/index.mjs:591-596`), so it cannot prove that the
external `tlds` dependency was actually applied. The plan must prescribe
`parser.tlds(tlds)` (with the intended replace/merge behavior) and a bare TLD
case absent from the built-in list.

## 2. [MEDIUM] E1's required red run is ordered after the implementation it claims to disprove

### What is wrong

The plan places E1 after S1-S3, but E1 Step 2 requires a red result "before
integration" because no anchors exist. S2 has already replaced all Timeline
body sites with `LinkifiedText`; under the literal task order, the new browser
test should pass rather than reach the stipulated red state.

### Evidence

- S2's implementation step changes the message, snippet, and full email body
  sites at `docs/superpowers/plans/2026-09-02-comms-clickable-links.md:463-503`.
- E1 is declared only after S3 at
  `docs/superpowers/plans/2026-09-02-comms-clickable-links.md:627-641`.
- Yet E1 Step 2 says to run the new test before integration and expects no link
  roles at `docs/superpowers/plans/2026-09-02-comms-clickable-links.md:711-722`.
- The plan itself says the rerun is after S1-S3 at
  `docs/superpowers/plans/2026-09-02-comms-clickable-links.md:724-733`.

### Implication

The claimed red-to-green evidence is impossible to obtain when the builder
executes the tasks in order. Move E1's test creation and red run before S2's
integration, or remove the false red-state requirement and state that it is a
post-integration acceptance test.

## 3. [MEDIUM] The plan does not perform the specified clean Windows dependency-install proof

### What is wrong

The approved dependency decision requires a successful clean workspace
installation on Windows. The plan only mutates and inspects the existing
worktree with `npm install`, `npm ls`, and a dashboard build. None verifies
that the committed lockfile installs from a clean Windows tree.

### Evidence

- The specification explicitly requires a successful clean workspace install on
  Windows before accepting the dependency commit:
  `docs/superpowers/specs/2026-09-02-comms-clickable-links-design.md:144-152`.
- S1 Step 1 runs ordinary `npm install` in the current tree:
  `docs/superpowers/plans/2026-09-02-comms-clickable-links.md:120-131`.
- S1 Step 2 only runs `npm ls`, a local manifest inspection, and an isolated
  Linux container probe: `docs/superpowers/plans/2026-09-02-comms-clickable-links.md:133-153`.
- Its later production build is also in the existing worktree:
  `docs/superpowers/plans/2026-09-02-comms-clickable-links.md:358-369`.

### Implication

An existing hoisted installation can hide a bad or incomplete lockfile. Add a
non-destructive clean Windows install proof against the committed dependency
graph, with an observable exit status, before declaring S1's dependency
boundary proven.

## 4. [MEDIUM] The mandated safe-boundary rejection case has no executable test

### What is wrong

The spec requires a test showing that a parser match rejected by `safeHttpUrl`
degrades to its exact original text. The plan tests disabled schemes and normal
safe links, but no planned assertion exercises the `href === null` branch of
the supplied tokenizer. Therefore a builder cannot demonstrate the mandated
final safety boundary, and a regression that bypasses it can still satisfy the
listed tests.

### Evidence

- The specification requires a focused test for HTTP(S) safety rejection with
  exact literal-text fallback:
  `docs/superpowers/specs/2026-09-02-comms-clickable-links-design.md:266-283`.
- The plan's test inventory covers unsupported schemes, HTML-looking text, and
  rendered safe-anchor attributes, but contains no controlled
  `safeHttpUrl`-rejection assertion:
  `docs/superpowers/plans/2026-09-02-comms-clickable-links.md:192-211`.
- The literal tokenizer has an untested rejection branch at
  `docs/superpowers/plans/2026-09-02-comms-clickable-links.md:285-292`.
- `safeHttpUrl` is the repository's final scheme authority and returns `null`
  for unparseable or non-HTTP(S) input:
  `dashboard/src/lib/safeUrl.ts:9-17`.

### Implication

The security invariant is implemented by a branch that the proposed test suite
never proves. Add a controlled unit test (for example, mock the boundary for a
recognized match) that asserts no anchor and byte-for-byte text preservation
when the boundary returns `null`.

## 5. [LOW] Native-group attribution is claimed but not tested

### What is wrong

The plan calls for a `relay_sender_key: 'team'` assertion only. That exercises
the Timeline's default relay behavior, not the native-group reader's distinct
`rosterKind="group_text"` path. The required Relay/native-group attribution
coverage is consequently left to builder inference.

### Evidence

- The specification explicitly requires Relay and native-group sender
  attribution around linkified text:
  `docs/superpowers/specs/2026-09-02-comms-clickable-links-design.md:285-295`.
- S2 specifies only the `relay_sender_key: 'team'` assertion:
  `docs/superpowers/plans/2026-09-02-comms-clickable-links.md:426-435`.
- Native group calls the shared Timeline with its separate `group_text` roster
  kind: `dashboard/src/routes/conversation/GroupTextView.tsx:448-462`.
- The Timeline passes that roster kind to `MessageBubble`:
  `dashboard/src/routes/contact/Timeline.tsx:1538-1566`, whose sender label is
  resolved from both roster and roster kind at
  `dashboard/src/routes/contact/Timeline.tsx:969-974`.

### Implication

The shared body replacement is likely to work for native groups, but the plan
does not prove the specifically approved reader variant remains intact. Add a
`rosterKind="group_text"` Timeline fixture with native-group attribution and a
link in the message body.
