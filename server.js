const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Visitors with no Homeroom account ("guests") may look around this app at
// its own address, read-only (every public app). The platform marks
// them with a token of their own: ES256, signed by a key of its own (its
// public half is USERNODE_GUEST_JWT_PUBLIC_KEY), this audience, `pur:
// 'guest'`, `guest: true`, and no id or username. Such a visitor is
// `req.guest`, never `req.user`, and every write they try is answered 401
// `account_required`, which the bridge turns into "Make an account to
// continue".
const GUEST_AUDIENCE = APP_AUDIENCE ? APP_AUDIENCE + ':guest' : null;
const GUEST_PUBLIC_KEY = (process.env.USERNODE_GUEST_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// "Now" for this request, as a Date: `req.now`, set for every request by
// the middleware below. Read the day and the time through it (and
// `usernode.now()` in the page), never `new Date()` or SQL's NOW(),
// wherever they decide what shows: a reminder, a rota, a deadline.
// Production always gets the real time. A staging preview may be shown as of
// a chosen moment: the platform opens it with `?un-now=<ISO time>`, and the
// page sends `usernode.now()` on as the `x-usernode-now` header. Only a
// staging container reads either. See "Time-dependent features" in the
// platform conventions.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PREVIEW_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function requestNow(req) {
  const raw = IS_STAGING ? (req.headers['x-usernode-now'] || req.query['un-now']) : null;
  return typeof raw === 'string' && PREVIEW_NOW.test(raw) ? new Date(raw) : new Date();
}

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  req.now = requestNow(req);
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }
  if (!req.user && token && GUEST_PUBLIC_KEY && GUEST_AUDIENCE) {
    try {
      const guest = jwt.verify(token, GUEST_PUBLIC_KEY, {
        algorithms: ['ES256'],
        issuer: 'usernode',
        audience: GUEST_AUDIENCE,
      });
      if (guest && guest.pur === 'guest' && guest.guest === true) req.guest = true;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet. A guest may READ: every GET,
  // `/api/*` included, so read routes must not assume req.user (use
  // `req.user ? req.user.id : null`). Every write needs an account.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user && req.guest) {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      return res.status(401).json({ error: 'account_required' });
    }
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ── Club Votes data ─────────────────────────────────────────────────────
// Decisions, their choices, one vote per person per decision, comments and
// reports. The tally is always derived from votes in SQL; nobody's vote is
// ever returned to anyone (the votes table is private and read only through
// counts, plus the viewer's own row via `myChoiceId`).

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decisions (
      id serial PRIMARY KEY,
      author_id text NOT NULL,
      author_name text NOT NULL,
      question text NOT NULL,
      created_at timestamptz NOT NULL,
      closed_at timestamptz,
      winner_choice_id int,
      hidden boolean NOT NULL DEFAULT false,
      demo boolean NOT NULL DEFAULT false,
      demo_key text UNIQUE
    );
    ALTER TABLE decisions ADD COLUMN IF NOT EXISTS closed_at timestamptz;
    ALTER TABLE decisions ADD COLUMN IF NOT EXISTS winner_choice_id int;
    ALTER TABLE decisions ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
    ALTER TABLE decisions ADD COLUMN IF NOT EXISTS demo boolean NOT NULL DEFAULT false;
    ALTER TABLE decisions ADD COLUMN IF NOT EXISTS demo_key text;

    CREATE TABLE IF NOT EXISTS choices (
      id serial PRIMARY KEY,
      decision_id int NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
      label text NOT NULL,
      position int NOT NULL
    );
    CREATE TABLE IF NOT EXISTS comments (
      id serial PRIMARY KEY,
      decision_id int NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
      author_id text NOT NULL,
      author_name text NOT NULL,
      body text NOT NULL,
      created_at timestamptz NOT NULL,
      hidden boolean NOT NULL DEFAULT false,
      demo boolean NOT NULL DEFAULT false
    );
    ALTER TABLE comments ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
    ALTER TABLE comments ADD COLUMN IF NOT EXISTS demo boolean NOT NULL DEFAULT false;

    -- Who voted for what is never returned, only counts: private.
    CREATE TABLE IF NOT EXISTS votes (
      decision_id int NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
      user_id text NOT NULL,
      choice_id int NOT NULL REFERENCES choices(id) ON DELETE CASCADE,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (decision_id, user_id)
    );
    COMMENT ON TABLE votes IS 'staging:private';

    -- Polymorphic, so no foreign key; three distinct reporters hide a post.
    CREATE TABLE IF NOT EXISTS reports (
      id serial PRIMARY KEY,
      target_type text NOT NULL CHECK (target_type IN ('decision', 'comment')),
      target_id int NOT NULL,
      reporter_id text NOT NULL,
      created_at timestamptz NOT NULL,
      UNIQUE (target_type, target_id, reporter_id)
    );
    COMMENT ON TABLE reports IS 'staging:private';

    CREATE TABLE IF NOT EXISTS demo_seeds (
      user_id text PRIMARY KEY,
      seeded_at timestamptz NOT NULL
    );
    COMMENT ON TABLE demo_seeds IS 'staging:private';
  `);
}

// The viewer's id, or null for a guest (guests read everything, write
// nothing — the middleware already answers writes 401).
function viewerOf(req) {
  return req.user ? req.user.id : null;
}

function demoModeOf(req) {
  return IS_STAGING && req.query.demo === '1';
}

function decisionJson(d) {
  return {
    id: d.id,
    question: d.question,
    authorName: d.author_name,
    isMine: !!d.is_mine,
    createdAt: d.created_at instanceof Date ? d.created_at.toISOString() : d.created_at,
    closedAt: d.closed_at ? (d.closed_at instanceof Date ? d.closed_at.toISOString() : d.closed_at) : null,
    winnerChoiceId: d.winner_choice_id,
    choices: d.choices,
    totalVotes: d.total_votes,
    myChoiceId: d.my_choice_id ?? null,
    commentCount: d.comment_count,
  };
}

// Loads decisions (all, or just `ids`) with their choices, derived tallies,
// the viewer's own vote and comment counts. Hides hidden rows and rows the
// viewer reported. Open decisions first, newest first, then closed ones by
// when they closed.
async function loadDecisions(viewer, demoMode, ids) {
  const where = ['d.hidden = false'];
  const params = [];
  if (ids) {
    params.push(ids);
    where.push(`d.id = ANY($${params.length}::int[])`);
  }
  if (!demoMode) where.push('d.demo = false');
  if (viewer) {
    params.push(viewer);
    where.push(`NOT EXISTS (
      SELECT 1 FROM reports r
      WHERE r.target_type = 'decision' AND r.target_id = d.id AND r.reporter_id = $${params.length}
    )`);
  }
  const dRows = (await pool.query(`
    SELECT d.id, d.author_id, d.author_name, d.question, d.created_at, d.closed_at, d.winner_choice_id,
           (SELECT count(*)::int FROM comments c
             WHERE c.decision_id = d.id AND c.hidden = false) AS comment_count
      FROM decisions d
      WHERE ${where.join(' AND ')}
      ORDER BY (d.closed_at IS NOT NULL) ASC,
               CASE WHEN d.closed_at IS NULL THEN d.created_at ELSE d.closed_at END DESC
  `, params)).rows;
  if (!dRows.length) return [];
  const idList = dRows.map((r) => r.id);
  const cRows = (await pool.query(`
    SELECT c.id, c.decision_id, c.label, c.position,
           (SELECT count(*)::int FROM votes v WHERE v.choice_id = c.id) AS votes
      FROM choices c
      WHERE c.decision_id = ANY($1::int[])
      ORDER BY c.position ASC
  `, [idList])).rows;
  const myVotes = new Map();
  if (viewer) {
    const vRows = (await pool.query(`
      SELECT decision_id, choice_id FROM votes
        WHERE user_id = $1 AND decision_id = ANY($2::int[])
    `, [viewer, idList])).rows;
    for (const r of vRows) myVotes.set(r.decision_id, r.choice_id);
  }
  for (const d of dRows) {
    d.choices = [];
    d.total_votes = 0;
    d.is_mine = viewer ? d.author_id === viewer : false;
  }
  for (const c of cRows) {
    const d = dRows.find((r) => r.id === c.decision_id);
    if (!d) continue;
    d.choices.push({ id: c.id, label: c.label, position: c.position, votes: c.votes });
    d.total_votes += c.votes;
  }
  for (const d of dRows) d.my_choice_id = myVotes.has(d.id) ? myVotes.get(d.id) : null;
  return dRows;
}

// The decision detail's comment thread, oldest first, same hiding rules.
async function loadComments(decisionId, viewer, demoMode) {
  const where = ['c.decision_id = $1', 'c.hidden = false'];
  const params = [decisionId];
  if (!demoMode) where.push('c.demo = false');
  if (viewer) {
    params.push(viewer);
    where.push(`NOT EXISTS (
      SELECT 1 FROM reports r
      WHERE r.target_type = 'comment' AND r.target_id = c.id AND r.reporter_id = $${params.length}
    )`);
  }
  const { rows } = await pool.query(`
    SELECT c.id, c.author_id, c.author_name, c.body, c.created_at
      FROM comments c
      WHERE ${where.join(' AND ')}
      ORDER BY c.created_at ASC, c.id ASC
  `, params);
  return rows.map((c) => ({
    id: c.id,
    authorName: c.author_name,
    isMine: viewer ? c.author_id === viewer : false,
    body: c.body,
    createdAt: c.created_at instanceof Date ? c.created_at.toISOString() : c.created_at,
  }));
}

// A decision that exists, is visible to this viewer and is open. Holds the
// row lock until the transaction ends, so a vote racing a close resolves
// one way or the other instead of interleaving.
async function lockDecision(client, id) {
  const { rows } = await client.query(
    'SELECT id, author_id, closed_at, demo FROM decisions WHERE id = $1 FOR UPDATE', [id],
  );
  return rows[0] || null;
}

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/api/decisions', ah(async (req, res) => {
  const demoMode = demoModeOf(req);
  if (demoMode) await ensureDemo(req);
  const rows = await loadDecisions(viewerOf(req), demoMode, null);
  res.json({ demo: demoMode, decisions: rows.map(decisionJson) });
}));

app.get('/api/decisions/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'not_found' });
  const demoMode = demoModeOf(req);
  if (demoMode) await ensureDemo(req);
  const [d] = await loadDecisions(viewerOf(req), demoMode, [id]);
  if (!d) return res.status(404).json({ error: 'not_found' });
  const comments = await loadComments(id, viewerOf(req), demoMode);
  res.json({ demo: demoMode, decision: { ...decisionJson(d), comments } });
}));

app.post('/api/decisions', ah(async (req, res) => {
  const question = String((req.body && req.body.question) || '').trim();
  const choices = Array.isArray(req.body && req.body.choices)
    ? req.body.choices.map((c) => String(c || '').trim()).filter(Boolean) : [];
  if (question.length < 3 || question.length > 140) {
    return res.status(400).json({ error: 'bad_question', message: 'Your question needs between 3 and 140 characters.' });
  }
  if (choices.length < 2 || choices.length > 6) {
    return res.status(400).json({ error: 'bad_choices', message: 'Add between two and six choices.' });
  }
  if (choices.some((c) => c.length > 60)) {
    return res.status(400).json({ error: 'bad_choice_label', message: 'A choice can be at most 60 characters.' });
  }
  const seen = new Set(choices.map((c) => c.toLowerCase()));
  if (seen.size !== choices.length) {
    return res.status(400).json({ error: 'duplicate_choice', message: 'Two choices are the same. Make them different.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dRow = (await client.query(`
      INSERT INTO decisions (author_id, author_name, question, created_at, demo)
        VALUES ($1, $2, $3, $4, false) RETURNING id
    `, [req.user.id, req.user.username, question, req.now])).rows[0];
    for (let i = 0; i < choices.length; i += 1) {
      await client.query('INSERT INTO choices (decision_id, label, position) VALUES ($1, $2, $3)',
        [dRow.id, choices[i], i + 1]);
    }
    await client.query('COMMIT');
    const [d] = await loadDecisions(req.user.id, false, [dRow.id]);
    return res.status(201).json({ decision: decisionJson(d) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

app.put('/api/decisions/:id/vote', ah(async (req, res) => {
  const id = Number(req.params.id);
  const choiceId = Number(req.body && req.body.choiceId);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'not_found' });
  if (!Number.isInteger(choiceId)) return res.status(400).json({ error: 'bad_choice', message: 'Pick a choice to vote for.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const d = await lockDecision(client, id);
    if (!d) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found' });
    }
    if (d.closed_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'closed', message: 'Voting has closed.' });
    }
    const own = (await client.query(
      'SELECT 1 FROM choices WHERE id = $1 AND decision_id = $2', [choiceId, id],
    )).rows.length;
    if (!own) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'bad_choice', message: 'That choice is not on this decision.' });
    }
    await client.query(`
      INSERT INTO votes (decision_id, user_id, choice_id, updated_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (decision_id, user_id)
        DO UPDATE SET choice_id = EXCLUDED.choice_id, updated_at = EXCLUDED.updated_at
    `, [id, req.user.id, choiceId, req.now]);
    await client.query('COMMIT');
    const [loaded] = await loadDecisions(req.user.id, demoModeOf(req), [id]);
    return res.json({ decision: decisionJson(loaded) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

app.delete('/api/decisions/:id/vote', ah(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'not_found' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const d = await lockDecision(client, id);
    if (!d) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found' });
    }
    if (d.closed_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'closed', message: 'Voting has closed.' });
    }
    await client.query('DELETE FROM votes WHERE decision_id = $1 AND user_id = $2', [id, req.user.id]);
    await client.query('COMMIT');
    const [loaded] = await loadDecisions(req.user.id, demoModeOf(req), [id]);
    return res.json({ decision: decisionJson(loaded) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

app.post('/api/decisions/:id/close', ah(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'not_found' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const d = await lockDecision(client, id);
    if (!d) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found' });
    }
    if (d.author_id !== req.user.id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'not_author', message: 'Only the person who asked can close this.' });
    }
    if (d.closed_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'already_closed', message: 'This decision is already closed.' });
    }
    const tally = (await client.query(`
      SELECT c.id, (SELECT count(*)::int FROM votes v WHERE v.choice_id = c.id) AS votes
        FROM choices c WHERE c.decision_id = $1 ORDER BY c.position ASC
    `, [id])).rows;
    const total = tally.reduce((sum, c) => sum + c.votes, 0);
    if (total === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'no_votes', message: 'A decision with no votes cannot be closed.' });
    }
    const top = Math.max(...tally.map((c) => c.votes));
    const leaders = tally.filter((c) => c.votes === top);
    let winnerId = null;
    if (leaders.length === 1) {
      winnerId = leaders[0].id;
    } else {
      const wanted = Number(req.body && req.body.choiceId);
      const pick = leaders.find((c) => c.id === wanted);
      if (!pick) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'tie', message: 'Two or more choices are tied. Pick which one the group goes with.' });
      }
      winnerId = pick.id;
    }
    await client.query(
      'UPDATE decisions SET closed_at = $2, winner_choice_id = $3 WHERE id = $1',
      [id, req.now, winnerId],
    );
    await client.query('COMMIT');
    const [loaded] = await loadDecisions(req.user.id, demoModeOf(req), [id]);
    return res.json({ decision: decisionJson(loaded) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

app.post('/api/decisions/:id/comments', ah(async (req, res) => {
  const id = Number(req.params.id);
  const body = String((req.body && req.body.body) || '').trim();
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'not_found' });
  if (!body || body.length > 500) {
    return res.status(400).json({ error: 'bad_comment', message: 'Write a comment of 1 to 500 characters.' });
  }
  const demoMode = demoModeOf(req);
  const visible = demoMode ? '1=1' : 'demo = false';
  const dRow = (await pool.query(
    `SELECT id FROM decisions WHERE id = $1 AND hidden = false AND ${visible}`, [id],
  )).rows[0];
  if (!dRow) return res.status(404).json({ error: 'not_found' });
  const cRow = (await pool.query(`
    INSERT INTO comments (decision_id, author_id, author_name, body, created_at, demo)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at
  `, [id, req.user.id, req.user.username, body, req.now, demoMode])).rows[0];
  return res.status(201).json({
    comment: {
      id: cRow.id,
      authorName: req.user.username,
      isMine: true,
      body,
      createdAt: cRow.created_at instanceof Date ? cRow.created_at.toISOString() : cRow.created_at,
    },
  });
}));

app.post('/api/reports', ah(async (req, res) => {
  const targetType = req.body && req.body.targetType;
  const targetId = Number(req.body && req.body.targetId);
  if (targetType !== 'decision' && targetType !== 'comment') {
    return res.status(400).json({ error: 'bad_target', message: 'You can report a decision or a comment.' });
  }
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ error: 'bad_target', message: 'You can report a decision or a comment.' });
  }
  const table = targetType === 'decision' ? 'decisions' : 'comments';
  const post = (await pool.query(
    `SELECT id, author_id FROM ${table} WHERE id = $1`, [targetId],
  )).rows[0];
  if (!post) return res.status(404).json({ error: 'not_found' });
  if (post.author_id === req.user.id) {
    return res.status(400).json({ error: 'own_post', message: "You can't report your own post." });
  }
  await pool.query(`
    INSERT INTO reports (target_type, target_id, reporter_id, created_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (target_type, target_id, reporter_id) DO NOTHING
  `, [targetType, targetId, req.user.id, req.now]);
  const reports = (await pool.query(
    'SELECT count(DISTINCT reporter_id)::int AS n FROM reports WHERE target_type = $1 AND target_id = $2',
    [targetType, targetId],
  )).rows[0].n;
  if (reports >= 3) {
    await pool.query(`UPDATE ${table} SET hidden = true WHERE id = $1`, [targetId]);
  }
  return res.json({ reported: true });
}));

// The app's first version ships a populated staging demo behind ?demo=1:
// shared made-up rows with fixed ids, plus the viewer's own rows, written
// once per account. Nothing seeds outside staging or without ?demo=1.
let demoSeededShared = false;
async function ensureDemo(req) {
  if (!IS_STAGING || req.query.demo !== '1') return;
  const now = req.now;
  const ago = (ms) => new Date(now.getTime() - ms);
  const DAY = 86400000;
  const HOUR = 3600000;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (!demoSeededShared) {
      // Shared decisions, choices, votes and comments — fixed ids, so a
      // re-run changes nothing.
      const fakeAuthors = [
        [900001, 'staging-demo-voter-0', 'maya.demo', 'Where should we meet on Saturday?', ago(2 * DAY), null, null],
        [900002, 'staging-demo-voter-0', 'priya.demo', 'Which day works for the spring clean-up?', ago(3 * HOUR), null, null],
        [900003, 'staging-demo-voter-0', 'sam.demo', 'Should we add a second weekly meetup?', ago(20 * 60000), null, null],
        [900004, 'staging-demo-voter-0', 'jo.demo', 'Name for the club newsletter', ago(9 * DAY), ago(5 * DAY), 9],
        [900005, 'staging-demo-voter-0', 'alex.demo', 'Start time for Thursday meetups', ago(12 * DAY), ago(7 * DAY), 12],
        [900006, 'staging-demo-voter-0', 'maya.demo', 'Club t-shirt design', ago(16 * DAY), ago(14 * DAY), 14],
      ];
      for (const [id, author, name, question, created, closed, winner] of fakeAuthors) {
        await client.query(`
          INSERT INTO decisions (id, author_id, author_name, question, created_at, closed_at, winner_choice_id, demo)
            VALUES ($1, $2, $3, $4, $5, $6, $7, true)
            ON CONFLICT (id) DO NOTHING
        `, [id, author, name, question, created, closed, winner]);
      }
      const fakeChoices = [
        [1, 900001, 'Riverside café', 1], [2, 900001, 'Library meeting room', 2], [3, 900001, "Someone's flat", 3],
        [4, 900002, 'Saturday morning', 1], [5, 900002, 'Sunday afternoon', 2], [6, 900002, 'Friday evening', 3],
        [7, 900003, 'Yes, a Wednesday one', 1], [8, 900003, 'No, one is enough', 2],
        [9, 900004, 'The Weekly Huddle', 1], [10, 900004, 'Club Notes', 2], [11, 900004, 'The Minutes', 3],
        [12, 900005, '7 pm', 1], [13, 900005, '8 pm', 2],
        [14, 900006, 'Mountain outline', 1], [15, 900006, 'Ballot box print', 2], [16, 900006, 'Plain logo', 3],
      ];
      for (const [id, decisionId, label, position] of fakeChoices) {
        await client.query(`
          INSERT INTO choices (id, decision_id, label, position)
            VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING
        `, [id, decisionId, label, position]);
      }
      // Fake voters 1..12 split across the choices. The viewer's own votes
      // are seeded with their rows below, so the viewer's seat is real.
      const fakeVotes = [];
      const spread = (decisionId, choiceId, from, to) => {
        for (let i = from; i <= to; i += 1) fakeVotes.push([decisionId, `staging-demo-voter-${i}`, choiceId]);
      };
      spread(900001, 1, 1, 5); spread(900001, 2, 6, 8); spread(900001, 3, 9, 10);
      spread(900002, 4, 1, 4); spread(900002, 5, 5, 7); spread(900002, 6, 8, 8);
      spread(900004, 9, 1, 7); spread(900004, 10, 8, 10); spread(900004, 11, 11, 12);
      spread(900005, 12, 1, 6); spread(900005, 13, 7, 9);
      spread(900006, 14, 1, 5); spread(900006, 15, 6, 7); spread(900006, 16, 8, 8);
      for (const [decisionId, userId, choiceId] of fakeVotes) {
        await client.query(`
          INSERT INTO votes (decision_id, user_id, choice_id, updated_at)
            VALUES ($1, $2, $3, $4) ON CONFLICT (decision_id, user_id) DO NOTHING
        `, [decisionId, userId, choiceId, now]);
      }
      const fakeComments = [
        [800001, 900001, 'priya.demo', 'Riverside has room for all of us outside.', ago(2 * DAY - HOUR)],
        [800002, 900001, 'sam.demo', 'The library closes at 6 on Saturdays though.', ago(1.5 * DAY)],
        [800003, 900001, 'alex.demo', "Someone's flat is cosiest if it rains.", ago(DAY)],
        [800004, 900001, 'jo.demo', 'Riverside it is, then. I can book the big table.', ago(20 * HOUR)],
        [800005, 900002, 'maya.demo', 'Saturday morning suits me best.', ago(2 * HOUR)],
        [800006, 900002, 'jo.demo', 'I can only make Sunday, for what it is worth.', ago(HOUR)],
        [800007, 900004, 'sam.demo', 'The Weekly Huddle reads like something we would actually say.', ago(8 * DAY)],
        [800008, 900004, 'priya.demo', 'Club Notes is shorter, easier to fit on a badge.', ago(7.5 * DAY)],
        [800009, 900004, 'alex.demo', 'Huddle. It sounds like us.', ago(7 * DAY)],
        [800010, 900004, 'maya.demo', 'Can we put the vote tally in each issue? Very on brand.', ago(6.5 * DAY)],
        [800011, 900004, 'jo.demo', 'The first one goes out Friday either way.', ago(6 * DAY)],
        [800012, 900004, 'sam.demo', 'Huddle it is. Good pick, everyone.', ago(5.5 * DAY)],
        [800013, 900005, 'jo.demo', '7 pm is after dinner for me.', ago(11 * DAY)],
        [800014, 900005, 'priya.demo', 'Either works. 7 pm is earlier, which I like.', ago(10 * DAY)],
        [800015, 900005, 'maya.demo', '8 pm was always a squeeze on the buses.', ago(9 * DAY)],
        [800016, 900006, 'alex.demo', 'Mountain outline, on a cream shirt.', ago(15 * DAY)],
        [800017, 900006, 'jo.demo', 'The ballot box print is very us, but the mountain is nicer.', ago(14.5 * DAY)],
      ];
      for (const [id, decisionId, name, body, created] of fakeComments) {
        await client.query(`
          INSERT INTO comments (id, decision_id, author_id, author_name, body, created_at, demo)
            VALUES ($1, $2, 'staging-demo-voter-0', $3, $4, $5, true)
            ON CONFLICT (id) DO NOTHING
        `, [id, decisionId, name, body, created]);
      }
      demoSeededShared = true;

      // Bump the serials past the fixed demo ids NOW, so the viewer's own
      // rows (inserted below with normal serials) can't collide with them.
      for (const table of ['decisions', 'choices', 'comments']) {
        await client.query(`
          SELECT setval(pg_get_serial_sequence('${table}', 'id'),
            GREATEST((SELECT COALESCE(MAX(id), 1) FROM ${table}), 1))
        `);
      }
    }

    // The viewer's own rows, written once per account: their own decision,
    // their votes and their seat in the outing thread.
    let seededViewer = false;
    if (req.user) {
      const marker = await client.query(`
        INSERT INTO demo_seeds (user_id, seeded_at) VALUES ($1, $2)
          ON CONFLICT DO NOTHING RETURNING user_id
      `, [req.user.id, now]);
      seededViewer = marker.rowCount > 0;
    }
    if (seededViewer) {
      const outing = (await client.query(`
        INSERT INTO decisions (author_id, author_name, question, created_at, demo, demo_key)
          VALUES ($1, $2, 'What should our next group outing be?', $3, true, $4)
          ON CONFLICT (demo_key) DO NOTHING
          RETURNING id
      `, [req.user.id, req.user.username, ago(DAY), 'outing:' + req.user.id])).rows[0];
      if (outing) {
        const labels = ['Picnic in the park', 'Museum late night', 'Mini golf', 'Board game café'];
        const choiceIds = [];
        for (let i = 0; i < labels.length; i += 1) {
          const c = (await client.query(
            'INSERT INTO choices (decision_id, label, position) VALUES ($1, $2, $3) RETURNING id',
            [outing.id, labels[i], i + 1],
          )).rows[0];
          choiceIds.push(c.id);
        }
        // Fake votes 2/3/2/1; the viewer's own vote for Museum late night
        // below brings it to 2/4/2/1.
        const spread = [[choiceIds[0], 2], [choiceIds[1], 3], [choiceIds[2], 2], [choiceIds[3], 1]];
        let voter = 1;
        for (const [choiceId, n] of spread) {
          for (let i = 0; i < n; i += 1) {
            await client.query(`
              INSERT INTO votes (decision_id, user_id, choice_id, updated_at)
                VALUES ($1, $2, $3, $4) ON CONFLICT (decision_id, user_id) DO NOTHING
            `, [outing.id, `staging-demo-voter-${voter}`, choiceId, now]);
            voter += 1;
          }
        }
        const viewerComments = [
          ['maya.demo', 'The museum has free entry after 6 on Fridays, so this one is cheap too.', ago(22 * HOUR)],
          ['sam.demo', 'Picnic only works if the weather holds. Could we keep it as a backup?', ago(21 * HOUR)],
          [req.user.username, 'Good idea. If it rains on the day we switch to the board game café.', ago(20 * HOUR)],
          ['priya.demo', 'Mini golf for me, but I am happy with anything on Friday.', ago(6 * HOUR)],
          ['alex.demo', 'Museum it is. I can bring the club banner for a group photo.', ago(HOUR)],
        ];
        for (const [name, body, created] of viewerComments) {
          await client.query(`
            INSERT INTO comments (decision_id, author_id, author_name, body, created_at, demo)
              VALUES ($1, $2, $3, $4, $5, true)
          `, [outing.id, name === req.user.username ? req.user.id : 'staging-demo-voter-0', name, body, created]);
        }
      }
      // The viewer's votes: Riverside café on the shared Saturday question,
      // and Museum late night on their own outing below.
      await client.query(`
        INSERT INTO votes (decision_id, user_id, choice_id, updated_at)
          VALUES ($1, $2, $3, $4) ON CONFLICT (decision_id, user_id) DO NOTHING
      `, [900001, req.user.id, 1, now]);
      if (outing) {
        const museum = (await client.query(
          'SELECT id FROM choices WHERE decision_id = $1 AND position = 2', [outing.id],
        )).rows[0];
        if (museum) {
          await client.query(`
            INSERT INTO votes (decision_id, user_id, choice_id, updated_at)
              VALUES ($1, $2, $3, $4) ON CONFLICT (decision_id, user_id) DO NOTHING
          `, [outing.id, req.user.id, museum.id, now]);
        }
      }
    }

    // Keep the serial sequences above the fixed demo ids.
    for (const table of ['decisions', 'choices', 'comments']) {
      await client.query(`
        SELECT setval(pg_get_serial_sequence('${table}', 'id'),
          GREATEST((SELECT COALESCE(MAX(id), 1) FROM ${table}), 1))
      `);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    demoSeededShared = false;
    throw err;
  } finally {
    client.release();
  }
}

// Anything the API handlers threw that was not a plain status answer: keep
// the shape the app expects, never leak a stack.
app.use('/api', (err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'load_failed', message: 'Something went wrong on the server. Try again.' });
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user && !req.guest) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/club-votes-cbc02a/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/club-votes-cbc02a/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await ensureSchema();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  // The platform stops the app with SIGTERM: stop taking requests, drain
  // what is in flight for a few seconds, then close the database pool.
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const shutdown = pool.end.bind(pool);
  process.on('exit', shutdown); // best effort if the process ends another way
}

start().catch(err => { console.error(err); process.exit(1); });
