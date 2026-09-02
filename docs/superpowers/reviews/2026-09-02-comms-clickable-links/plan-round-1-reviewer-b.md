# Plan review round 1 - reviewer B

## 1. BLOCKING - The prescribed parser never loads the full `tlds` list, and its tests cannot expose that failure

What is wrong:

The specification requires the complete `tlds` list to govern fuzzy bare-domain recognition (spec section 5, lines 131-135; section 6, lines 158-167 and 189-193). The exact implementation in S1 only passes `tlds` as an unrecognized constructor-object property and never calls the parser API that replaces its TLD list (plan lines 245-252). A builder who follows that code literally will retain the parser's short built-in suffix list, so valid current public domains outside that list are rendered as text. The specified tests do not include a suffix outside the built-in list: `housing.museum` is explicitly one of the built-ins, and the parser accepts encoded international domains independently of the supplied full list.

Evidence:

- Spec lines 131-135 and 158-167 require the full direct `tlds` list, not the package merely being present.
- Plan lines 245-252 construct the parser and disable schemas, but contain no `.tlds(tlds)` call.
- The currently resolved parser documents only `fuzzyLink`, `fuzzyEmail`, and `fuzzyIP` as options at `node_modules/linkify-it/index.mjs:33-43`; its constructor assigns those options but resets `__tlds__` to its default list at `node_modules/linkify-it/index.mjs:339-361`.
- That parser exposes `tlds(list)` as the explicit list-loading API at `node_modules/linkify-it/index.mjs:587-608`. Its default list already includes `museum` and permits encoded IDNs at `node_modules/linkify-it/index.mjs:591-599`, exactly matching the plan's insufficient test examples at plan lines 198-199.
- The supplied `tlds` data contains current suffixes such as `dev`, `page`, and `zip` at `node_modules/tlds/index.json:322`, `node_modules/tlds/index.json:866`, and `node_modules/tlds/index.json:1286`, but no S1 test requires one of them to link.

Implication:

The central recognition promise for valid public domains is not delivered, and the focused proof can still pass. The plan must prescribe loading the list through the parser's actual API after construction and add a bare-domain-with-path case using a suffix absent from the parser's built-in list (for example, `.zip`) before S1 can be implemented safely.

## 2. MEDIUM - The Timeline replacement loses the existing truncated all-whitespace snippet

What is wrong:

The current snippet contract renders three periods whenever a body is longer than 140 characters, including a body whose first 140 characters are all whitespace. The prescribed replacement computes a zero `snippetEnd` for that input and renders nothing because it conditions the whole component, including its suffix, on `snippetEnd > 0`. That contradicts the locked requirement to preserve the current 140-character/trailing-whitespace contract without an exception for whitespace-only content (spec lines 76-80 and 217-223).

Evidence:

- Current `EmailCard` calculates `snippet` as `${bodyText.slice(0, EMAIL_SNIPPET_CHARS).trimEnd()}...` whenever truncated at `dashboard/src/routes/contact/Timeline.tsx:1477-1479`, then renders it whenever that resulting string is nonempty at `dashboard/src/routes/contact/Timeline.tsx:1500`.
- For a 141-character whitespace-only body, that existing expression is `...`, so it is visible.
- The plan calculates `snippetEnd` from the trimmed visible slice at plan lines 481-484, then omits `LinkifiedText` and its `suffix={truncated ? '...' : undefined}` when `snippetEnd` is zero at plan lines 490-494.
- The planned tests cover trailing spaces only after a visible character (plan lines 439-450); they do not exercise the zero-visible-character truncated case.

Implication:

A literal implementation changes an existing user-visible email preview and does not satisfy the stated preservation guarantee. The plan needs a rendering path that emits the suffix whenever truncated, even when `snippetEnd` is zero, plus a focused regression test for a 141-character whitespace-only body.
