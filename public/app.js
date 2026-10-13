/* Club Votes — the whole front end.
 *
 * Two screens behind a tiny hash router:
 *   #/          the list of open and decided decisions
 *   #/d/:id     one decision: vote, comment, (its author can) close
 * Plus a post sheet for new decisions, presented with the platform's
 * native sheet. All user-written text goes in through textContent, so a
 * question or comment can never inject markup.
 */
(function () {
  'use strict';

  // ── Tiny DOM helper ───────────────────────────────────────────────────
  // Children that are strings become text nodes; the `html` attribute is
  // only ever used with the trusted icon constants below.
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'html') el.innerHTML = v;
        else if (k === 'class') el.className = v;
        else if (k === 'dataset') for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = dv;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'value') el.value = v;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  // ── Icons (trusted constants; the only thing allowed through `html`) ──
  const ICONS = {
    ballot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="9" width="18" height="12" rx="2"/><path d="M7 9l2.5-5h5L17 9"/><path d="M9 13.5l2 2 4-4"/></svg>',
    boxEmpty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/></svg>',
    boxTick: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 12.5l2.5 2.5 5-5"/></svg>',
    tickCircle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 5-5"/></svg>',
    bubble: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-8 8H4l2.2-3.3A8 8 0 1 1 21 12z"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    chevronLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  };

  // Choice colours, by the position a choice was added in. Written as
  // whole literals so the Tailwind extractor sees them.
  const CHOICE_BG = ['', 'bg-choice-1', 'bg-choice-2', 'bg-choice-3', 'bg-choice-4', 'bg-choice-5', 'bg-choice-6'];

  // ── Native kit, with quiet fallbacks for runs outside the platform ────
  const native = {
    toast(message) {
      try { if (window.unNative && window.unNative.toast) return window.unNative.toast(message); } catch (_) {}
      console.log('[toast]', message);
    },
    confirm(title, message, confirmLabel) {
      try {
        if (window.unNative && window.unNative.alert) {
          return window.unNative.alert({
            title, message,
            buttons: [{ label: 'Cancel', value: 'cancel' }, { label: confirmLabel, value: 'confirm' }],
          }).then((r) => !!(r && (r.value === 'confirm' || r.button === 'confirm')));
        }
      } catch (_) {}
      return Promise.resolve(window.confirm(message || title));
    },
    pick(title, labels) {
      try {
        if (window.unNative && window.unNative.actionSheet) {
          return window.unNative.actionSheet({
            title,
            actions: labels.map((label, i) => ({ label, value: i })),
            cancelLabel: 'Cancel',
          }).then((r) => {
            if (r === null || r === undefined) return null;
            if (typeof r === 'number') return r;
            if (typeof r.value === 'number') return r.value;
            if (r.action && typeof r.action.value === 'number') return r.action.value;
            return null;
          });
        }
      } catch (_) {}
      const pick = window.prompt(title + '\n\n' + labels.map((l, i) => (i + 1) + '. ' + l).join('\n'));
      if (!pick) return Promise.resolve(null);
      const idx = labels.findIndex((l) => l.toLowerCase() === pick.trim().toLowerCase());
      return Promise.resolve(idx >= 0 ? idx : null);
    },
    presentSheet(contentEl, onDismiss) {
      try {
        if (window.unNative && window.unNative.presentSheet) {
          return window.unNative.presentSheet({ contentEl, onDismiss });
        }
      } catch (_) {}
      // Minimal stand-in so the flow works outside the platform too.
      const backdrop = h('div', {
        style: 'position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;',
        onclick: (e) => { if (e.target === backdrop) close(); },
      });
      const sheet = h('div', {
        class: 'w-full max-w-md mx-auto rounded-t-2xl border border-line border-b-0 bg-surface p-4',
        style: 'max-height:85vh;overflow-y:auto;padding-bottom:max(1rem, env(safe-area-inset-bottom));',
      }, contentEl);
      function close() { backdrop.remove(); if (onDismiss) onDismiss(); }
      backdrop.append(sheet);
      document.body.append(backdrop);
      return { dismiss: close };
    },
    transition(fn, type) {
      try {
        if (window.unNative && window.unNative.transition) return window.unNative.transition(fn, { type });
      } catch (_) {}
      return fn();
    },
  };

  // ── API ───────────────────────────────────────────────────────────────
  // The platform bridge injects the viewer's token; the demo flag rides
  // along so staging's seeded data follows the URL.
  const DEMO = new URLSearchParams(location.search).get('demo') === '1';

  // The bridge carries the viewer's token inside Homeroom; the ?token= query
  // the platform puts on the iframe URL is the fallback outside it.
  const URL_TOKEN = new URLSearchParams(location.search).get('token');

  function platformNow() {
    try { if (window.usernode && window.usernode.now) { const t = window.usernode.now(); if (t) return Number(t); } } catch (_) {}
    return Date.now();
  }

  async function api(method, path, body) {
    const url = '/api/' + path + (DEMO ? (path.includes('?') ? '&' : '?') + 'demo=1' : '');
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      if (window.usernode && window.usernode.token) headers['x-usernode-token'] = window.usernode.token;
      else if (URL_TOKEN) headers['x-usernode-token'] = URL_TOKEN;
    } catch (_) {}
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      const err = new Error(data.message || 'Request failed');
      err.status = res.status;
      err.code = data.error;
      throw err;
    }
    return data;
  }

  // ── State ─────────────────────────────────────────────────────────────
  const state = {
    demo: false,
    decisions: [],
    loaded: false,       // the list load has finished (ok or not)
    listError: null,     // the first load failed
    refreshError: false, // a poll failed; keep the data on screen
    detail: null,        // the open decision (detail screen)
    detailError: null,   // 'not_found' | 'error'
    detailLoading: false,
    route: null, // set by the first onRoute()
  };

  let listPollAt = 0;
  let detailPollAt = 0;
  let pollTimer = null;

  const screen = document.getElementById('screen');

  function render() {
    if (state.route.screen === 'detail') renderDetail();
    else renderList();
  }

  function navigate(hash, type) {
    native.transition(() => { location.hash = hash; }, type);
  }

  // ── Shared bits ───────────────────────────────────────────────────────
  function agoText(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return '';
    const s = Math.max(0, Math.floor((platformNow() - t) / 1000));
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const hr = Math.floor(m / 60);
    if (hr < 24) return hr + 'h ago';
    const d = Math.floor(hr / 24);
    if (d < 7) return d + 'd ago';
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function wrap(el) {
    el.style.overflowWrap = 'anywhere';
    return el;
  }

  function ballotBox(on) {
    return h('span', { class: 'ballot-box' + (on ? ' is-on' : ''), html: on ? ICONS.boxTick : ICONS.boxEmpty, 'aria-hidden': true });
  }

  function tallyStrip(choices, total, large) {
    const strip = h('div', { class: 'tally my-2' + (large ? ' tally-lg' : ''), role: 'img', 'aria-label': 'Votes by choice' });
    if (!total) {
      strip.append(h('div', { class: 'tally-empty' }));
      return strip;
    }
    const top = Math.max(...choices.map((c) => c.votes));
    for (const c of choices) {
      const seg = h('div', { class: ('tally-seg ' + segClass(c.position)).trim() });
      if (c.votes === top && top > 0) seg.classList.add('is-lead');
      seg.style.flexGrow = String(Math.max(c.votes, 0.001) * 1000);
      seg.style.backgroundColor = '';
      strip.append(seg);
    }
    return strip;
  }

  // Note: the class lookup must stay whole literals, so a segment with an
  // out-of-range position just gets no colour rather than a composed name.
  function segClass(position) {
    return CHOICE_BG[position] || '';
  }

  function leaderInfo(d) {
    const open = !d.closedAt;
    const withVotes = d.choices.filter((c) => c.votes > 0);
    const top = Math.max(...d.choices.map((c) => c.votes));
    const leaders = d.choices.filter((c) => c.votes === top);
    if (!d.totalVotes) return { tie: false, leaders: [], top: 0 };
    return { tie: leaders.length > 1, leaders, top, open };
  }

  function commentCount(count) {
    return h('span', { class: 'inline-flex items-center gap-1 text-small text-muted' },
      h('span', { class: 'inline-block h-4 w-4', html: ICONS.bubble, 'aria-hidden': true }),
      String(count));
  }

  // ── List screen ───────────────────────────────────────────────────────
  function renderList() {
    screen.dataset.screen = 'list';
    screen.replaceChildren();

    const open = state.decisions.filter((d) => !d.closedAt);
    const decided = state.decisions.filter((d) => d.closedAt);

    // Header
    const headText = h('div', { class: 'min-w-0 flex-1' },
      h('h1', { class: 'text-title font-display' }, 'Club Votes'));
    if (state.loaded && !state.listError) {
      headText.append(h('p', { class: 'text-small text-muted' }, `${open.length} open, ${decided.length} decided`));
    }
    screen.append(h('header', { class: 'mb-3 flex items-center gap-3' },
      h('div', { class: 'flex h-12 w-12 flex-none items-center justify-center rounded-xl bg-accent/10 text-accent', html: ICONS.ballot, 'aria-hidden': true }),
      headText,
      h('button', { class: 'btn-primary', onclick: openPostSheet }, h('span', { class: 'h-5 w-5', html: ICONS.plus, 'aria-hidden': true }), 'Post')));

    if (state.demo) {
      screen.append(h('p', { class: 'mb-3 rounded-lg bg-raised px-3 py-2 text-small text-muted' },
        'Staging demo: these decisions, votes and comments are made-up sample data.'));
    }

    if (!state.loaded) {
      renderListSkeleton();
      return;
    }
    if (state.listError) {
      screen.append(h('div', { class: 'state-error' },
        h('h2', { class: 'text-heading font-display' }, "Couldn't load decisions."),
        h('p', { class: 'text-small text-muted' }, 'Your connection or the server may be down. Nothing you posted is lost.'),
        h('button', { class: 'btn-secondary mt-2', onclick: loadList }, 'Retry')));
      return;
    }
    if (state.refreshError) {
      screen.append(h('p', { class: 'flex items-center gap-2 px-1 text-small text-muted' },
        "Couldn't refresh. ",
        h('button', { class: 'font-medium text-accent underline', onclick: () => pollList(true) }, 'Retry')));
    }

    if (!state.decisions.length) {
      screen.append(h('div', { class: 'state-empty flex-1' },
        h('div', { class: 'flex h-12 w-12 items-center justify-center rounded-xl bg-raised text-muted', html: ICONS.ballot, 'aria-hidden': true }),
        h('h2', { class: 'text-heading font-display' }, 'Nothing to decide yet'),
        h('p', { class: 'text-small text-muted' }, 'Post the first question for the group.'),
        h('button', { class: 'btn-primary mt-2', onclick: openPostSheet }, 'Post the first question')));
      return;
    }

    if (open.length) {
      screen.append(h('h2', { class: 'section-label' }, 'Open'));
      screen.append(cardsWrap(open));
    }
    if (decided.length) {
      screen.append(h('h2', { class: 'section-label' }, 'Decided'));
      screen.append(cardsWrap(decided));
    }
  }

  // 10 px of vertical space between decision cards, per the spec.
  function cardsWrap(cards) {
    return h('div', { class: 'flex flex-col gap-2.5' }, cards.map(decisionCard));
  }

  function renderListSkeleton() {
    screen.append(h('div', { class: 'flex flex-col gap-2.5' },
      Array.from({ length: 3 }, () => h('div', { class: 'card flex flex-col gap-3' },
        h('div', { class: 'skeleton h-5 w-3/4' }),
        h('div', { class: 'skeleton h-3 w-1/3' }),
        h('div', { class: 'skeleton h-4 w-full' }),
        h('div', { class: 'skeleton h-3 w-2/3' })))));
  }

  function decisionCard(d) {
    const closed = !!d.closedAt;
    const card = h('button', {
      class: 'card w-full text-left',
      dataset: { decisionCard: '' },
      onclick: () => navigate('#/d/' + d.id, 'push'),
    });
    card.append(h('h3', { class: 'text-heading font-display' }, wrapTextNode(d.question)));
    if (!closed) {
      card.append(h('p', { class: 'text-small text-muted' }, `Asked by ${d.authorName}, ${agoText(d.createdAt)}`));
      card.append(tallyStrip(d.choices, d.totalVotes, false));
      const li = leaderInfo(d);
      let line;
      let leadRow;
      if (!d.totalVotes) {
        leadRow = h('p', { class: 'text-small' }, 'No votes yet. Be the first.');
      } else {
        if (li.tie) line = `${li.leaders.map((c) => c.label).join(' and ')} are tied with ${li.top} votes each`;
        else line = `${li.leaders[0].label} leads with ${li.top} of ${d.totalVotes} votes`;
        // Swatch(es) in the leader's choice colour, so the line names the slip.
        leadRow = h('p', { class: 'flex items-center gap-1.5 text-small' },
          li.leaders.map((c) => h('span', { class: 'swatch ' + segClass(c.position), 'aria-hidden': true })),
          h('span', { class: 'min-w-0' }, line));
      }
      card.append(leadRow);
      card.append(h('div', { class: 'mt-3 flex items-center justify-between border-t border-line pt-3' },
        d.myChoiceId
          ? h('span', { class: 'chip chip-done' }, h('span', { class: 'inline-block h-4 w-4', html: ICONS.boxTick, 'aria-hidden': true }), `You voted ${choiceLabel(d, d.myChoiceId)}`)
          : h('span', { class: 'chip chip-todo' }, h('span', { class: 'inline-block h-4 w-4', html: ICONS.boxEmpty, 'aria-hidden': true }), 'You have not voted'),
        commentCount(d.commentCount)));
    } else {
      card.append(tallyStrip(d.choices, d.totalVotes, false));
      const winner = d.choices.find((c) => c.id === d.winnerChoiceId);
      card.append(h('p', { class: 'mt-3 flex items-center gap-2 text-small font-medium' },
        h('span', { class: 'inline-block h-5 w-5 flex-none text-accent', html: ICONS.tickCircle, 'aria-hidden': true }),
        `Picked ${winner ? winner.label : '—'}, ${totalFor(d, d.winnerChoiceId)} of ${d.totalVotes} votes`));
      card.append(h('div', { class: 'mt-3 flex items-center justify-between border-t border-line pt-3' },
        h('span', { class: 'text-small text-muted' }, `Closed by ${d.authorName}, ${agoText(d.closedAt)}`),
        commentCount(d.commentCount)));
    }
    return card;
  }

  function wrapTextNode(text) {
    return wrap(h('span', {}, text));
  }

  function choiceLabel(d, id) {
    const c = d.choices.find((x) => x.id === id);
    return c ? c.label : '';
  }

  function totalFor(d, choiceId) {
    const c = d.choices.find((x) => x.id === choiceId);
    return c ? c.votes : 0;
  }

  // ── Detail screen ─────────────────────────────────────────────────────
  function renderDetail() {
    screen.dataset.screen = 'detail';
    screen.replaceChildren();

    screen.append(h('button', {
      class: '-ml-2 inline-flex min-h-11 items-center gap-1 text-body font-medium text-accent',
      onclick: () => navigate('#/', 'pop'),
    }, h('span', { class: 'h-5 w-5', html: ICONS.chevronLeft, 'aria-hidden': true }), 'All decisions'));

    if (state.detailLoading && !state.detail) {
      screen.append(h('div', { class: 'mt-4 flex flex-col gap-3' },
        h('div', { class: 'skeleton h-7 w-5/6' }),
        h('div', { class: 'skeleton h-3 w-1/3' }),
        h('div', { class: 'skeleton h-6 w-full' }),
        h('div', { class: 'skeleton h-24 w-full' }),
        h('div', { class: 'skeleton h-12 w-full' })));
      return;
    }
    if (state.detailError === 'not_found') {
      screen.append(h('div', { class: 'state-error flex-1' },
        h('h2', { class: 'text-heading font-display' }, "This decision isn't available."),
        h('p', { class: 'text-small text-muted' }, 'It may have been removed, or the link may be wrong.')));
      return;
    }
    if (state.detailError) {
      screen.append(h('div', { class: 'state-error flex-1' },
        h('h2', { class: 'text-heading font-display' }, "Couldn't load this decision."),
        h('p', { class: 'text-small text-muted' }, 'Your connection or the server may be down.'),
        h('button', { class: 'btn-secondary mt-2', onclick: loadDetail }, 'Retry')));
      return;
    }

    const d = state.detail;
    const closed = !!d.closedAt;

    if (state.refreshError) {
      screen.append(h('p', { class: 'flex items-center gap-2 px-1 text-small text-muted' },
        "Couldn't refresh. ",
        h('button', { class: 'font-medium text-accent underline', onclick: () => pollDetail(true) }, 'Retry')));
    }

    screen.append(h('div', { class: 'mt-2 flex items-center gap-2' },
      closed
        ? h('span', { class: 'chip chip-done' }, 'Decided')
        : h('span', { class: 'chip chip-todo' }, 'Open')));
    screen.append(h('h1', { class: 'mt-2 text-title font-display' }, wrapTextNode(d.question)));
    const meta = h('p', { class: 'text-small text-muted' },
      d.isMine ? `Asked by you, ${agoText(d.createdAt)}` : `Asked by ${d.authorName}, ${agoText(d.createdAt)}`);
    if (!d.isMine) {
      meta.append(' ');
      meta.append(h('button', { class: 'font-medium text-accent underline', onclick: () => reportPost('decision', d) }, 'Report'));
    }
    screen.append(meta);

    screen.append(tallyStrip(d.choices, d.totalVotes, true));
    const li = leaderInfo(d);
    screen.append(h('p', { class: 'text-small text-muted' },
      !d.totalVotes ? 'No votes yet.'
        : li.tie ? `${d.totalVotes} votes so far. ${li.leaders.map((c) => c.label).join(' and ')} are tied.`
        : `${d.totalVotes} votes so far. ${li.leaders[0].label} is ahead.`));

    // Choices
    screen.append(h('h2', { class: 'section-label mt-4' }, 'Choices'));
    const list = h('ul', { class: 'list' });
    d.choices.forEach((c) => {
      const mine = d.myChoiceId === c.id;
      const row = h('li', { class: 'list-row !block' });
      const tap = h('button', {
        class: 'flex w-full items-center gap-3 text-left' + (closed ? ' cursor-default' : ''),
        onclick: closed ? undefined : () => vote(d, c),
        'aria-pressed': closed ? undefined : String(mine),
      },
        ballotBox(mine),
        h('div', { class: 'min-w-0 flex-1' },
          h('p', { class: 'flex items-center gap-2 text-body' },
            h('span', { class: 'swatch ' + segClass(c.position), 'aria-hidden': true }),
            wrapTextNode(c.label),
            closed && d.winnerChoiceId === c.id
              ? h('span', { class: 'inline-block h-4 w-4 flex-none text-accent', html: ICONS.tickCircle, 'aria-hidden': true })
              : null),
          h('div', { class: 'share-bar' },
            h('div', { class: 'share-fill ' + segClass(c.position), style: 'flex-grow:' + String(c.votes * 1000) }))),
        h('span', { class: 'text-small text-muted' }, `${c.votes} votes`));
      row.append(tap);
      list.append(row);
    });
    screen.append(list);

    // Hint
    screen.append(h('p', { class: 'px-1 pt-2 text-small text-muted' },
      closed ? 'Voting has closed.'
        : d.myChoiceId ? `You voted ${choiceLabel(d, d.myChoiceId)}. Tap another choice to change your vote, or tap it again to take your vote back.`
        : 'Tap a choice to vote.'));

    // Close (author only, while open)
    if (!closed && d.isMine) {
      const sole = !li.tie && li.leaders.length === 1 ? li.leaders[0] : null;
      const canClose = d.totalVotes > 0;
      const closeBtn = h('button', {
        class: 'btn-secondary w-full',
        disabled: !canClose,
        onclick: () => closeFlow(d, sole),
      }, sole ? `Close and pick ${sole.label}` : 'Close and pick a winner');
      screen.append(h('div', { class: 'mt-4 flex flex-col gap-2' },
        closeBtn,
        h('p', { class: 'text-small text-muted' },
          canClose ? 'Only you can close this, because you asked it.' : 'You can close this once someone has voted.')));
    }

    // Comments
    screen.append(h('h2', { class: 'section-label mt-6' }, 'Comments'));
    if (!d.comments.length) {
      screen.append(h('p', { class: 'px-1 text-small text-muted' }, 'No comments yet.'));
    } else {
      const cl = h('ul', { class: 'list' });
      for (const c of d.comments) {
        const row = h('li', { class: 'list-row !block !items-start' });
        const head = h('p', { class: 'flex items-center gap-2 text-small' },
          h('span', { class: 'font-medium text-fg' }, c.authorName),
          c.isMine ? h('span', { class: 'chip chip-done !px-1.5 !py-0' }, 'You') : null,
          h('span', { class: 'text-muted' }, agoText(c.createdAt)));
        if (!c.isMine) {
          head.append(h('button', {
            class: 'ml-auto font-medium text-accent underline',
            onclick: () => reportPost('comment', c),
          }, 'Report'));
        }
        row.append(head, wrap(h('p', { class: 'text-body' }, c.body)));
        cl.append(row);
      }
      screen.append(cl);
    }

    // Add a comment
    const textarea = h('textarea', { class: 'field min-h-20', placeholder: 'Add a comment', maxlength: '500' });
    const commentBtn = h('button', {
      class: 'btn-primary self-start',
      onclick: () => postComment(d, textarea),
    }, 'Comment');
    screen.append(h('div', { class: 'mt-3 flex flex-col gap-2' }, textarea, commentBtn));
  }

  // ── Actions ───────────────────────────────────────────────────────────
  async function loadList() {
    state.refreshError = false;
    if (!state.loaded) { state.listError = null; renderListSkeletonOnly(); }
    try {
      const data = await api('GET', 'decisions');
      state.decisions = data.decisions;
      state.demo = data.demo;
      state.listError = null;
      state.refreshError = false;
    } catch (err) {
      if (state.loaded) state.refreshError = true;
      else state.listError = true;
    }
    state.loaded = true;
    render();
  }

  // Skeleton without touching the header/state flags.
  function renderListSkeletonOnly() {
    screen.dataset.screen = 'list';
    screen.replaceChildren();
    renderListSkeleton();
  }

  async function loadDetail() {
    const id = state.route.id;
    state.detailLoading = true;
    state.detailError = null;
    state.refreshError = false;
    if (!state.detail || state.detail.id !== id) { state.detail = null; render(); }
    try {
      const data = await api('GET', 'decisions/' + id);
      if (state.route.id !== id) return;
      state.detail = data.decision;
      state.demo = data.demo;
      state.detailError = null;
      state.refreshError = false;
    } catch (err) {
      if (state.route.id !== id) return;
      state.detailError = err.status === 404 ? 'not_found' : 'error';
    }
    state.detailLoading = false;
    render();
  }

  async function pollList(force) {
    if (document.visibilityState !== 'visible' && !force) return;
    try {
      const data = await api('GET', 'decisions');
      state.decisions = data.decisions;
      state.demo = data.demo;
      state.refreshError = false;
      render();
    } catch (_) {
      state.refreshError = true;
      render();
    }
  }

  async function pollDetail(force) {
    if (document.visibilityState !== 'visible' && !force) return;
    const id = state.route.id;
    try {
      const data = await api('GET', 'decisions/' + id);
      if (state.route.id !== id) return;
      state.detail = data.decision;
      state.refreshError = false;
      render();
    } catch (err) {
      if (state.route.id !== id) return;
      if (err.status === 404) { state.detailError = 'not_found'; state.detail = null; }
      else state.refreshError = true;
      render();
    }
  }

  // One ticker drives both cadences: the open decision refreshes every 10s,
  // the list every 30s, and only while the app is visible.
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (state.route.screen === 'detail') {
        if (now - detailPollAt >= 10000 && state.detail && !state.detailLoading) {
          detailPollAt = now;
          pollDetail(false);
        }
      } else if (now - listPollAt >= 30000 && state.loaded && !state.listError) {
        listPollAt = now;
        pollList(false);
      }
    }, 2000);
  }

  function vote(d, choice) {
    const prev = d.myChoiceId;
    const retract = prev === choice.id;
    const before = JSON.stringify(d);

    // Optimistic: move the viewer's vote and adjust the counts locally.
    if (prev) d.choices.find((c) => c.id === prev).votes -= 1;
    if (retract) d.myChoiceId = null;
    else { choice.votes += 1; d.myChoiceId = choice.id; }
    render();

    const call = retract
      ? api('DELETE', 'decisions/' + d.id + '/vote')
      : api('PUT', 'decisions/' + d.id + '/vote', { choiceId: choice.id });
    call.then((data) => {
      // Vote responses carry no comments; keep the ones already on screen.
      data.decision.comments = (state.detail && state.detail.comments) || [];
      state.detail = data.decision;
      // Keep the list card in step too.
      const inList = state.decisions.find((x) => x.id === d.id);
      if (inList) refreshCardFrom(inList, data.decision);
      render();
    }).catch((err) => {
      const restored = JSON.parse(before);
      const live = state.detail && state.detail.id === d.id ? state.detail : null;
      if (live) {
        live.myChoiceId = restored.myChoiceId;
        live.choices = restored.choices;
        live.totalVotes = restored.totalVotes;
      }
      const inList = state.decisions.find((x) => x.id === d.id);
      if (inList) {
        inList.myChoiceId = restored.myChoiceId;
        inList.choices = restored.choices;
        inList.totalVotes = restored.totalVotes;
      }
      render();
      if (err.status === 409) {
        native.toast('Voting has closed.');
        pollDetail(true);
      } else if (err.status === 401) {
        // The bridge asks the viewer to sign in; nothing more to do here.
      } else {
        native.toast("Your vote didn't go through. Try again.");
      }
    });
  }

  function refreshCardFrom(target, from) {
    target.question = from.question;
    target.choices = from.choices.map((c) => ({ ...c }));
    target.totalVotes = from.totalVotes;
    target.myChoiceId = from.myChoiceId;
    target.closedAt = from.closedAt;
    target.winnerChoiceId = from.winnerChoiceId;
    target.commentCount = from.commentCount;
  }

  async function closeFlow(d, sole) {
    let choiceId = null;
    if (sole) {
      const ok = await native.confirm('Close and pick ' + sole.label + '?', 'Voting ends for everyone. This cannot be undone.', 'Close');
      if (!ok) return;
      choiceId = sole.id;
    } else {
      const tied = leaderInfo(d).leaders;
      const idx = await native.pick('Two or more choices are tied. Pick which one the group goes with.', tied.map((c) => c.label));
      if (idx === null || idx === undefined) return;
      choiceId = tied[idx].id;
    }
    try {
      const data = await api('POST', 'decisions/' + d.id + '/close', { choiceId });
      // Close responses carry no comments; keep the ones already on screen.
      data.decision.comments = d.comments || [];
      state.detail = data.decision;
      const inList = state.decisions.find((x) => x.id === d.id);
      if (inList) refreshCardFrom(inList, data.decision);
      render();
      native.toast('Decision closed');
    } catch (err) {
      if (err.status === 401) return;
      native.toast(err.message || "Couldn't close this decision. Try again.");
      pollDetail(true);
    }
  }

  async function postComment(d, textarea) {
    const body = textarea.value.trim();
    if (!body || body.length > 500) {
      native.toast('Write a comment of 1 to 500 characters.');
      return;
    }
    try {
      const data = await api('POST', 'decisions/' + d.id + '/comments', { body });
      d.comments.push(data.comment);
      d.commentCount += 1;
      textarea.value = '';
      render();
    } catch (err) {
      if (err.status === 401) return;
      native.toast(err.message || "Your comment didn't go through. Try again.");
    }
  }

  async function reportPost(type, post) {
    const what = type === 'decision' ? 'this decision' : 'this comment';
    const ok = await native.confirm('Report ' + what + '?', 'It will be hidden for you.', 'Report');
    if (!ok) return;
    try {
      await api('POST', 'reports', { targetType: type, targetId: post.id });
      if (type === 'comment') {
        const d = state.detail;
        if (d) { d.comments = d.comments.filter((c) => c.id !== post.id); d.commentCount = Math.max(0, d.commentCount - 1); }
      } else {
        state.decisions = state.decisions.filter((x) => x.id !== post.id);
        navigate('#/', 'pop');
      }
      native.toast('Reported');
      render();
    } catch (err) {
      if (err.status === 401) return;
      native.toast(err.message || "Couldn't send that report. Try again.");
    }
  }

  // ── Post sheet ────────────────────────────────────────────────────────
  function openPostSheet() {
    const swatch = (i) => h('span', { class: 'swatch ' + segClass(i), 'aria-hidden': true });

    const question = h('input', {
      class: 'field', type: 'text', maxlength: '140',
      placeholder: 'e.g. Where should we meet on Saturday?',
    });
    const questionCount = h('p', { class: 'px-1 pt-1 text-small text-muted' }, '3 to 140 characters.');
    const choiceWrap = h('div', { class: 'flex flex-col gap-2' });
    const addBtn = h('button', { class: 'btn-secondary self-start', onclick: () => addChoice() },
      h('span', { class: 'h-5 w-5', html: ICONS.plus, 'aria-hidden': true }), 'Add a choice');
    const postBtn = h('button', { class: 'btn-primary w-full', disabled: true, onclick: submit }, 'Post decision');
    const errorLine = h('p', { class: 'hidden px-1 text-small text-danger' });

    let rows = [];
    let sheetHandle = null;

    function row(i) {
      const placeholders = ['e.g. Riverside café', 'e.g. Library meeting room', 'e.g. Picnic in the park',
        'e.g. Museum late night', 'e.g. Mini golf', 'e.g. Board game café'];
      const input = h('input', { class: 'field', type: 'text', maxlength: '60', placeholder: placeholders[i] });
      input.addEventListener('input', validate);
      const remove = h('button', {
        class: 'btn-secondary !min-h-11 !min-w-11 !px-0',
        'aria-label': 'Remove this choice',
        onclick: () => { rows = rows.filter((r) => r !== row); draw(); },
      }, h('span', { class: 'h-5 w-5', html: ICONS.x, 'aria-hidden': true }));
      const r = { input, el: null };
      r.el = h('div', { class: 'flex items-end gap-2' },
        h('div', { class: 'min-w-0 flex-1' },
          h('p', { class: 'mb-1 flex items-center gap-2 text-small text-muted' }, 'Choice ' + (i + 1), swatch(i + 1)),
          input),
        rows.length >= 2 ? remove : null);
      return r;
    }

    function draw() {
      choiceWrap.replaceChildren(...rows.map((r) => r.el));
      // Renumber the labels after a removal, and re-place remove buttons:
      // they belong on choices 3 to 6 only.
      rows.forEach((r, i) => {
        const label = r.el.querySelector('p');
        label.replaceChildren('Choice ' + (i + 1), swatch(i + 1));
        const has = !!r.el.querySelector('button');
        if (i >= 2 && !has) r.el.append(removeFor(r));
        if (i < 2 && has) r.el.querySelector('button').remove();
      });
      addBtn.disabled = rows.length >= 6;
      addBtn.classList.toggle('hidden', rows.length >= 6);
      validate();
    }

    function removeFor(r) {
      return h('button', {
        class: 'btn-secondary !min-h-11 !min-w-11 !px-0',
        'aria-label': 'Remove this choice',
        onclick: () => { rows = rows.filter((x) => x !== r); draw(); },
      }, h('span', { class: 'h-5 w-5', html: ICONS.x, 'aria-hidden': true }));
    }

    function addChoice() {
      if (rows.length >= 6) return;
      rows.push(row(rows.length));
      draw();
    }

    function values() {
      return rows.map((r) => r.input.value.trim()).filter(Boolean);
    }

    function validate() {
      const q = question.value.trim();
      const picks = values();
      const distinct = new Set(picks.map((p) => p.toLowerCase())).size === picks.length;
      const okQ = q.length >= 3 && q.length <= 140;
      const okC = picks.length >= 2 && picks.length <= 6 && distinct;
      postBtn.disabled = !(okQ && okC);
      if (okQ && okC) errorLine.classList.add('hidden');
      else if (picks.length >= 2 && !distinct) {
        errorLine.textContent = 'Two choices are the same. Make them different.';
        errorLine.classList.remove('hidden');
      }
    }

    async function submit() {
      errorLine.classList.add('hidden');
      postBtn.disabled = true;
      try {
        const data = await api('POST', 'decisions', {
          question: question.value.trim(),
          choices: values(),
        });
        const inList = data.decision;
        state.decisions.unshift(inList);
        if (sheetHandle) sheetHandle.dismiss();
        native.toast('Decision posted');
        navigate('#/d/' + inList.id, 'push');
      } catch (err) {
        if (err.status === 401) return;
        errorLine.textContent = err.message || "Couldn't post this. Try again.";
        errorLine.classList.remove('hidden');
        postBtn.disabled = false;
      }
    }

    question.addEventListener('input', validate);

    rows.push(row(0), row(1));
    const content = h('div', { class: 'flex flex-col gap-4' },
      h('h2', { class: 'text-heading font-display' }, 'Post a decision'),
      h('div', {},
        h('label', { class: 'mb-1 block text-small font-medium text-fg', for: 'post-question' }, 'Question'),
        question,
        questionCount),
      h('div', {},
        h('p', { class: 'mb-1 text-small font-medium text-fg' }, 'Choices'),
        choiceWrap,
        h('div', { class: 'pt-2' }, addBtn)),
      errorLine,
      postBtn);
    question.id = 'post-question';
    draw();
    sheetHandle = native.presentSheet(content, () => {});
    setTimeout(() => question.focus(), 50);
  }

  // ── Router ────────────────────────────────────────────────────────────
  function parseRoute() {
    const m = location.hash.match(/^#\/d\/(\d+)/);
    if (m) return { screen: 'detail', id: Number(m[1]) };
    return { screen: 'list', id: null };
  }

  function onRoute() {
    const next = parseRoute();
    const prev = state.route;
    const changedScreen = !prev || next.screen !== prev.screen || next.id !== prev.id;
    state.route = next;
    state.refreshError = false;
    if (!changedScreen) return;
    if (next.screen === 'detail') {
      state.detail = null;
      state.detailError = null;
      state.detailLoading = true;
      detailPollAt = Date.now();
      loadDetail();
    } else {
      state.detail = null;
      listPollAt = Date.now();
      if (!state.loaded) loadList();
      else render();
    }
  }

  window.addEventListener('hashchange', onRoute);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (state.route.screen === 'detail' && state.detail) pollDetail(false);
    else if (state.route.screen === 'list' && state.loaded && !state.listError) pollList(false);
  });

  startPolling();
  onRoute();
})();