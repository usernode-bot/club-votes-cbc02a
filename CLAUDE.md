# Club Votes — notes for Claude Code

This app runs on **Homeroom**. The platform conventions are the single
source of truth for platform-wide behavior (auth model, `USERNODE_ENV`,
public/private tables, "don't `git push`", etc.):

**Platform conventions (authoritative, always current):**
https://app.onhomeroom.com/claude.md

**Inside Homeroom** (its dev chat, and Homeroom bot's builds), do not
fetch that URL: what applies to your change is already in your
instructions, and the `homeroom` MCP server's
`get_platform_conventions` reads any one section of the conventions
when you need it. The two sections below are for working outside
Homeroom; skip them there.

**Anywhere else** (Claude Code run against this repo locally, or another
harness), fetch it at the start of each session. The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

## Connector permission prompts (outside Homeroom)

This repo ships `.claude/settings.json`, which allows the **read-only**
Homeroom connector calls (`mcp__homeroom__get_*`,
`…__list_*`, `…__whoami`) once you accept the workspace trust dialog.
See `.claude/README.md` for the whole story, including what to do if you
are still being prompted.

## Check that this checkout is current

You may be working in a fork of this app whose `main` is behind the app's
canonical repository, and nothing in the checkout says so: `git fetch origin`
compares the fork with itself. This matters before you **read** code to answer
a question about how the app behaves now, not only before you edit it.

The canonical repository is named in `.claude/homeroom-canonical-repo`. Check against
it, not against `origin`:

```sh
git fetch "$(cat .claude/homeroom-canonical-repo)" main
git merge-base --is-ancestor FETCH_HEAD HEAD && echo current || echo behind
```

`behind` means this checkout does not contain the canonical `main`. To answer
a question, read the canonical code instead (`git show FETCH_HEAD:<path>`,
`git grep <pattern> FETCH_HEAD`). To change code, start from the exact base
commit your Homeroom work order gives, and never merge or rebase onto the
canonical `main` yourself: which commit a change is diffed against decides
what the group votes on. With the Homeroom connector, `get_checkout_status`
answers the same question.

A session-start hook (`.claude/hooks/homeroom-freshness.sh`, see `.claude/README.md`) runs
this check for you and tells you when you are behind. It is silent offline, so
its silence is not proof the checkout is current. Inside Homeroom (its dev
chat, and Homeroom bot's builds) the platform fixes the base commit, and none
of this applies.

## Starter template

The starter template screen has been replaced by the real app (the first
version of Club Votes); this section is kept only for the notes below it.

Keep the `usernode-dev-console@1` forwarder `<script>` in
`public/index.html` — that block is platform infrastructure, not template
content. So is the bridge `<script>`, and the theme `<script>` right
after the bridge tag, which sets a `dark` class on `<html>` so the app
follows the viewer's Homeroom theme. Give everything you build both
looks (the design kit's colour tokens carry both). Unless a request asks
for one, add no theme picker: the viewer's Homeroom setting is the
control. "The platform's light/dark theme inside the app frame" in the
platform conventions has the details.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About Club Votes

Decide things together, one vote at a time. Anyone posts a question with
2–6 choices, everyone in the group votes (one changeable vote per
person), people discuss in comments, and the asker closes the decision
when the group has settled — that close picks the winner and is final.
Reports hide a post or comment from everyone once three different people
have reported it. Guests can read everything but cannot vote, post, or
close.

## Design

This app's look. Every change follows it, and updates it when a request
changes the look on purpose.

- **Palette:** accent "election ink" violet (`bg-accent`/`text-accent`)
  on cool ballot-paper greys (`bg-ground`, `bg-surface`); neutrals are
  cool greys with hairline `border-line`. Choice colours (teal, amber,
  rose, blue, green, slate) label the options and never include the
  accent violet, so the accent stays reserved for actions and the
  viewer's own marks.
- **Signature element:** the tally strip — one horizontal bar per
  decision, segmented by choice in the choice colours, the leading
  segment twice as tall, dashed and empty at zero votes. Ballot-box
  squares fill with ink and a tick when the viewer has voted.
- **Type scale:** `text-title`, `text-heading`, `text-body`,
  `text-small`, with a rounded display face (`font-display`) for the
  app title and question text only.

The kit is in `styles/tailwind-input.css`: colour tokens with a light and
a dark value (named in `tailwind.config.js`), and a few components
(`btn-primary`, `btn-secondary`, `field`, `list` and `list-row`,
`card`, `section-label`, `skeleton`, `state-empty`, `state-error`).
Re-theme by changing the token values there, keeping every text pair at
4.5:1 or more in both looks.

- Colour comes only from the tokens (`bg-ground`, `bg-surface`,
  `text-fg`, `text-muted`, `border-line`, `bg-accent` with
  `text-on-accent`, ...): never a raw hex value or a stock palette class.
- Tap targets are at least 44 px; the buttons and fields already are.
- A field's label says what it is; its placeholder, if any, is an example
  that says so ("e.g. 5.0"), never a bare value that could pass for one
  already entered.
- Every screen that loads data has honest loading, empty and error states.
  Never show the empty state while loading or after a failure; an error says
  what failed, what still works, and offers Retry.
- Seed obviously fake staging demo data so the populated screen can be seen
  ("Staging mock data" in the platform conventions).
- No cards in cards, no uppercase eyebrows, no emoji as icons.

## App-specific conventions

- The `decisions`, `choices`, `votes`, `comments`, `reports`, and
  `demo_seeds` tables are marked `staging:private` — they hold
  user-posted content and per-account demo state, so never expose them
  publicly.
- User-written text (questions, choices, comments) is rendered with
  `textContent` only; never build DOM for it from HTML strings.
- Writes are optimistic in the client and roll back with a toast on
  failure; vote and close writes serialize with `SELECT … FOR UPDATE`
  on the decision row.
- Vote/close API responses return the decision without its comments;
  the client keeps the comments already on screen when merging. Don't
  assign such a response straight to the detail state.
- Demo data (`?demo=1`, staging only) seeds six shared decisions
  (ids 900001+) plus one per-account outing decision guarded by the
  `demo_seeds` table. Everything on demo rows is votable and
  commentable like real data.
