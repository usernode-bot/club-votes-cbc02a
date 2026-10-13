# Club Votes

Decide things together, one vote at a time. Anyone in the group posts a
question with 2 to 6 choices, everyone votes, and the person who asked
closes the decision when the group is ready.

## How it works

- **Decisions list** — open decisions first, then decided ones. Each card
  shows the question, a tally strip of the votes so far (the leading
  choice's segment is twice as tall), who is ahead, and whether you have
  voted.
- **Voting** — tap a choice to vote, tap another to change your vote, tap
  your own choice again to take your vote back. One vote per person, and
  it stays changeable until the decision closes.
- **Closing** — only the person who asked can close, and only once
  someone has voted. If two or more choices are tied for the lead, the
  asker picks which one the group goes with. Closing is final.
- **Comments** — anyone can discuss a decision, before or after it
  closes.
- **Reporting** — anything posted by someone else can be reported; a
  post or comment hidden after reports from three different people
  disappears for everyone.

## Staging demo

On staging, open the app with `?demo=1` in the URL to see the list
populated with six shared example decisions plus an outing question of
your own, all fully votable and commentable. Your account seeds its own
copy of the outing question once, so the demo never collides with real
posts.

## Under the hood

- Express + Postgres. Decisions, choices, votes, comments, and reports
  live in private tables; every request carries the platform-issued
  user token (an RS256 JWT) so the app knows who is acting. Guests can
  read but not vote or post.
- The client is a small hash-routed single-page app in `public/app.js`.
  Votes are applied optimistically and rolled back with a toast if the
  write fails. The list and detail screens poll for fresh votes while
  the app is visible.
- Tailwind CSS, precompiled by `npm run build`, in a light and a dark
  look that follow the viewer's Homeroom theme.