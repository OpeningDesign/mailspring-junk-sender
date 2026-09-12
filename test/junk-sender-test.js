// Loads the real plugin code with stubbed Mailspring modules and checks its behavior.
const Module = require('module');
const assert = require('assert');
const path = require('path');

const PLUGIN = path.join(__dirname, '..', 'lib');

let rules = [];
let messages = [];
let dbThreads = [];
let parsedQueries = [];
let threadQueries = [];
let listener = null;
const calls = {
  addMailRule: [],
  queueTasks: [],
  popSheet: 0,
  popover: [],
  closePopover: 0,
  registered: [],
  unregistered: [],
};
const accounts = {
  imap: { usesLabels: () => false, emailAddress: 'me@example.com' },
  gmail: { usesLabels: () => true, emailAddress: 'me@gmail.com' },
};
const junk = { id: 'junk-id', displayName: 'Junk' };

class Component {
  constructor(props) {
    this.props = props;
  }
  setState(s) {
    this.state = Object.assign({}, this.state, s);
  }
}

function Message() {}
const Thread = {
  attributes: {
    categories: { contains: (id) => (t) => t.categories.includes(id) },
    lastMessageReceivedTimestamp: {
      descending: () => 'lmrt desc',
      lessThanOrEqualTo: (v) => (t) => t.lastMessageReceivedTimestamp <= v,
    },
  },
};

// Mimics the FTS index: `from:"x"` is a prefix match, so it over-matches look-alike addresses.
function ftsFromMatches(thread, parsed) {
  const term = /from:"(.*)"/.exec(parsed.query)[1].toLowerCase();
  return messages.some(
    (m) => m.threadId === thread.id && m.from.some((c) => c.email.toLowerCase().startsWith(term))
  );
}

class Query {
  constructor(klass, where) {
    this.klass = klass;
    this.whereClause = where || {};
    this.matchers = [];
    this.parsed = null;
    this.ordered = false;
    this.limitCount = null;
    this.isBackground = false;
  }
  where(matcher) {
    this.matchers.push(matcher);
    return this;
  }
  structuredSearch(parsed) {
    this.parsed = parsed;
    return this;
  }
  order() {
    this.ordered = true;
    return this;
  }
  limit(n) {
    this.limitCount = n;
    return this;
  }
  background() {
    this.isBackground = true;
    return this;
  }
  then(resolve, reject) {
    return Promise.resolve()
      .then(() => this.run())
      .then(resolve, reject);
  }
  run() {
    if (this.klass === Message) {
      return messages.filter((m) => this.whereClause.threadId.includes(m.threadId));
    }
    threadQueries.push(this);
    let rows = dbThreads.filter(
      (t) =>
        t.accountId === this.whereClause.accountId &&
        this.matchers.every((m) => m(t)) &&
        (!this.parsed || ftsFromMatches(t, this.parsed))
    );
    if (this.ordered) {
      rows = rows
        .slice()
        .sort((a, b) => b.lastMessageReceivedTimestamp - a.lastMessageReceivedTimestamp);
    }
    return this.limitCount === null ? rows : rows.slice(0, this.limitCount);
  }
}

const stubs = {
  'mailspring-exports': {
    React: { Component, createElement: (type, props, ...children) => ({ type, props, children }) },
    Actions: {
      addMailRule: (r) => calls.addMailRule.push(r),
      queueTasks: (t) => calls.queueTasks.push(t),
      popSheet: () => calls.popSheet++,
      openPopover: (el, opts) => calls.popover.push({ el, opts }),
      closePopover: () => calls.closePopover++,
    },
    Thread,
    Message,
    AccountStore: { accountForId: (id) => accounts[id] },
    CategoryStore: {
      getSpamCategory: () => junk,
      getInboxCategory: () => ({ id: 'inbox-id' }),
    },
    DatabaseStore: { findAll: (klass, where) => new Query(klass, where) },
    MailRulesStore: {
      rules: () => rules,
      listen: (fn) => {
        listener = fn;
        return () => (listener = null);
      },
    },
    SearchQueryParser: {
      parse: (query) => {
        parsedQueries.push(query);
        return { query };
      },
    },
    TaskFactory: {
      tasksForMarkingAsSpam: ({ threads }) => [`task:${threads.map((t) => t.id).join(',')}`],
    },
    ComponentRegistry: {
      register: (c, opts) => calls.registered.push([c, opts]),
      unregister: (c) => calls.unregistered.push(c),
    },
  },
  'mailspring-component-kit': {
    RetinaImg: Object.assign(function RetinaImg() {}, { Mode: { ContentIsMask: 'mask' } }),
  },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  return stubs[request] || origLoad.call(this, request, ...rest);
};

const JunkSenderButton = require(`${PLUGIN}/junk-sender-button.js`);
const PatternPopover = require(`${PLUGIN}/pattern-popover.js`);
const junkSender = require(`${PLUGIN}/junk-sender.js`);
const main = require(`${PLUGIN}/main.js`);

const contact = (email, me = false, name = null) => ({ email, name, isMe: () => me });
const msg = (threadId, email, date, me, name) => ({
  threadId,
  from: [contact(email, me, name)],
  date: new Date(date),
});
const thread = (id, accountId, folders = [], categories = [], lmrt = 0) => ({
  id,
  accountId,
  folders,
  categories,
  lastMessageReceivedTimestamp: lmrt,
});
const flush = () => new Promise((r) => setImmediate(r));
const click = (b, event = {}) =>
  b._onClick(
    Object.assign(
      { stopPropagation() {}, currentTarget: { getBoundingClientRect: () => ({ top: 1 }) } },
      event
    )
  );
const SHIFT_HINT =
  '\nShift-click to match part of the address (like a newsletter name) or a /regular expression/.';
const INBOX_SUFFIX = ", including what's already in your Inbox";

// Collects the text of a rendered element tree, so assertions can read what the popover shows.
function textOf(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  return textOf(node.children);
}

function reset() {
  rules = [];
  messages = [];
  dbThreads = [];
  parsedQueries = [];
  threadQueries = [];
  calls.addMailRule = [];
  calls.queueTasks = [];
  calls.popSheet = 0;
  calls.popover = [];
  calls.closePopover = 0;
}

async function mount(items) {
  const b = new JunkSenderButton({ items });
  b.componentDidMount();
  await flush();
  return b;
}

function popover(props = {}) {
  const p = new PatternPopover(
    Object.assign({ accountId: 'imap', folder: junk, seed: 'weekly@substack.com' }, props)
  );
  p.componentDidMount();
  return p;
}

const tests = {
  async 'uses newest non-me sender, lowercased, and names the Junk folder'() {
    messages = [
      msg('t1', 'old@x.com', 1),
      msg('t1', 'New@Spam.com', 2),
      msg('t1', 'me@me.com', 3, true),
    ];
    const b = await mount([thread('t1', 'imap')]);
    const el = b.render();
    assert.strictEqual(el.type, 'button');
    assert.strictEqual(
      el.props.title,
      `Always move mail from new@spam.com to Junk${INBOX_SUFFIX}${SHIFT_HINT}`
    );
    assert.ok(el.children[0].props.url.startsWith('data:image/svg+xml,'));
    assert.ok(!el.props['aria-label'].includes('\n'), 'aria-label stays on one line');
  },

  async 'click creates a changeFolder rule and moves the thread to spam'() {
    messages = [msg('t1', 'New@Spam.com', 2)];
    const b = await mount([thread('t1', 'imap')]);
    await click(b);
    assert.deepStrictEqual(calls.addMailRule, [
      {
        accountId: 'imap',
        name: 'Junk mail from new@spam.com',
        conditionMode: 'all',
        conditions: [{ templateKey: 'from', comparatorKey: 'equals', value: 'new@spam.com' }],
        actions: [{ templateKey: 'changeFolder', value: 'junk-id' }],
      },
    ]);
    assert.deepStrictEqual(calls.queueTasks, [['task:t1']]);
    assert.strictEqual(calls.popSheet, 1);
  },

  async 'click also moves Inbox threads from the sender, confirmed by message sender'() {
    const selected = thread('t1', 'imap', [], ['inbox-id']);
    dbThreads = [
      selected, // selected and in the Inbox: moved once
      thread('t2', 'imap', [], ['inbox-id']), // from the sender (different case): moved
      thread('t3', 'imap', [], ['inbox-id']), // look-alike address the index over-matches: kept
      thread('t4', 'imap', [], ['archive-id']), // from the sender but not in the Inbox: kept
      thread('t5', 'other', [], ['inbox-id']), // from the sender on another account: kept
    ];
    messages = [
      msg('t1', 'new@spam.com', 5),
      msg('t2', 'New@Spam.com', 1),
      msg('t3', 'new@spam.com.evil.net', 1),
      msg('t4', 'new@spam.com', 1),
      msg('t5', 'new@spam.com', 1),
    ];
    const b = await mount([selected]);
    await click(b);
    assert.deepStrictEqual(parsedQueries, ['from:"new@spam.com"']);
    assert.deepStrictEqual(calls.queueTasks, [['task:t1,t2']]);
  },

  async 'stays after the rule exists; clicking again moves Inbox mail without a duplicate rule'() {
    const selected = thread('t1', 'imap', [], ['inbox-id']);
    dbThreads = [selected, thread('t2', 'imap', [], ['inbox-id'])];
    messages = [msg('t1', 'new@spam.com', 2), msg('t2', 'new@spam.com', 1)];
    const b = await mount([selected]);
    await click(b);
    rules = calls.addMailRule.map((r) => JSON.parse(JSON.stringify(r)));
    rules[0].conditions[0].value = 'NEW@spam.com'; // case-insensitive match
    listener();
    await flush();
    assert.strictEqual(
      b.render().props.title,
      `Move mail from new@spam.com that's in your Inbox to Junk. A rule already filters their new mail.${SHIFT_HINT}`
    );

    calls.addMailRule = [];
    calls.queueTasks = [];
    await click(b);
    assert.deepStrictEqual(calls.addMailRule, []);
    assert.deepStrictEqual(calls.queueTasks, [['task:t1,t2']]);
  },

  async 'mixed selection creates rules only for senders without one'() {
    rules = [
      {
        accountId: 'imap',
        conditions: [{ templateKey: 'from', comparatorKey: 'equals', value: 'a@spam.com' }],
        actions: [{ templateKey: 'changeFolder', value: 'junk-id' }],
      },
    ];
    messages = [msg('t1', 'a@spam.com', 1), msg('t2', 'b@spam.com', 1)];
    const b = await mount([thread('t1', 'imap'), thread('t2', 'imap')]);
    await click(b);
    assert.deepStrictEqual(
      calls.addMailRule.map((r) => r.conditions[0].value),
      ['b@spam.com']
    );
    assert.deepStrictEqual(calls.queueTasks, [['task:t1,t2']]);
  },

  async 'a rule for a different folder does not count as a junk rule'() {
    rules = [
      {
        accountId: 'imap',
        conditions: [{ templateKey: 'from', comparatorKey: 'equals', value: 'a@spam.com' }],
        actions: [{ templateKey: 'changeFolder', value: 'receipts-id' }],
      },
    ];
    messages = [msg('t1', 'a@spam.com', 1)];
    const b = await mount([thread('t1', 'imap')]);
    await click(b);
    assert.strictEqual(calls.addMailRule.length, 1);
  },

  async 'an existing substring rule covers a matching sender'() {
    rules = [
      {
        accountId: 'imap',
        conditions: [{ templateKey: 'from', comparatorKey: 'contains', value: 'minocquabrewing' }],
        actions: [{ templateKey: 'changeFolder', value: 'junk-id' }],
      },
    ];
    messages = [msg('t1', 'minocquabrewingcompanytimes+weekly@substack.com', 1)];
    const b = await mount([thread('t1', 'imap')]);
    assert.ok(b.render().props.title.startsWith('Move mail from minocquabrewing'));
    assert.ok(b.render().props.title.includes('A rule already filters their new mail.'));
  },

  async 'an existing expression rule covers a matching sender'() {
    rules = [
      {
        accountId: 'imap',
        conditions: [
          { templateKey: 'from', comparatorKey: 'matchesExpression', value: 'minocqua.*@substack' },
        ],
        actions: [{ templateKey: 'changeFolder', value: 'junk-id' }],
      },
    ];
    messages = [msg('t1', 'minocquabrewingcompanytimes+weekly@substack.com', 1)];
    const b = await mount([thread('t1', 'imap')]);
    assert.ok(b.render().props.title.includes('A rule already filters their new mail.'));
  },

  async 'a broken expression rule covers nothing and is skipped'() {
    rules = [
      {
        accountId: 'imap',
        conditions: [{ templateKey: 'from', comparatorKey: 'matchesExpression', value: '([' }],
        actions: [{ templateKey: 'changeFolder', value: 'junk-id' }],
      },
    ];
    messages = [msg('t1', 'a@spam.com', 1)];
    const b = await mount([thread('t1', 'imap')]);
    assert.ok(b.render().props.title.startsWith('Always move mail'));
  },

  async 'matcherFor: plain text is a case-insensitive substring of address or name'() {
    const m = junkSender.matcherFor('  minocquabrewing ');
    assert.strictEqual(m.comparatorKey, 'contains');
    assert.strictEqual(m.value, 'minocquabrewing');
    assert.ok(m.test('minocquabrewingcompanytimes+weekly-roundup@substack.com'));
    assert.ok(m.test('MinocquaBrewing@substack.com'));
    assert.ok(m.test('someone@substack.com', 'MinocquaBrewing Times')); // matches the name too
    assert.ok(!m.test('other@substack.com'));
  },

  async 'matcherFor: /…/ is an expression, and an invalid one throws'() {
    const m = junkSender.matcherFor('/^minocqua.*@substack\\.com$/');
    assert.strictEqual(m.comparatorKey, 'matchesExpression');
    assert.strictEqual(m.value, '^minocqua.*@substack\\.com$');
    assert.ok(m.test('MinocquaBrewingCompany@substack.com'));
    assert.ok(!m.test('minocqua@example.com'));
    assert.throws(() => junkSender.matcherFor('/([/'));
  },

  async 'shift-click opens the pattern popover seeded with the address'() {
    messages = [msg('t1', 'minocquabrewingcompanytimes+weekly@substack.com', 1)];
    const b = await mount([thread('t1', 'imap')]);
    await click(b, { shiftKey: true });
    assert.strictEqual(calls.addMailRule.length, 0);
    assert.strictEqual(calls.queueTasks.length, 0);
    assert.strictEqual(calls.popover.length, 1);
    assert.deepStrictEqual(calls.popover[0].opts, { originRect: { top: 1 }, direction: 'down' });
    assert.deepStrictEqual(calls.popover[0].el.props, {
      accountId: 'imap',
      folder: junk,
      seed: 'minocquabrewingcompanytimes+weekly@substack.com',
    });
  },

  async 'popover: checking scans the Inbox in pages and reports matches'() {
    for (let i = 0; i < 1200; i++) {
      dbThreads.push(thread(`p${i}`, 'imap', [], ['inbox-id'], 100000 - i));
    }
    messages = [
      msg('p0', 'minocquabrewingcompanytimes+weekly@substack.com', 1),
      msg('p600', 'someone@substack.com', 1, false, 'MinocquaBrewing Company'),
      msg('p1100', 'MinocquaBrewing+daily@substack.com', 1),
      msg('p5', 'friend@example.com', 1),
    ];
    const p = popover({ seed: 'minocquabrewing' });
    await p._onCheck();

    assert.strictEqual(p.state.phase, 'checked');
    assert.strictEqual(p.state.scanned, 1200);
    assert.deepStrictEqual(
      p.state.matches.map((t) => t.id),
      ['p0', 'p600', 'p1100']
    );
    // 500 + 499 + 201 threads, then a fourth page holding only the repeated boundary thread.
    assert.strictEqual(threadQueries.length, 4, 'should page through the Inbox');
    assert.ok(
      threadQueries.every((q) => q.isBackground && q.ordered && q.limitCount === 500),
      'scan queries run in the background, ordered and paged'
    );
    const text = textOf(p.render());
    assert.ok(text.includes('3 in your Inbox match'), text);
    assert.ok(text.includes('minocquabrewingcompanytimes+weekly@substack.com'), text);
    assert.ok(text.includes('Create rule & move 3'), text);
  },

  async 'popover: confirming creates a contains rule and moves the matches'() {
    dbThreads = [
      thread('i1', 'imap', [], ['inbox-id'], 3),
      thread('i2', 'imap', [{ role: 'spam' }], ['inbox-id'], 2),
    ];
    messages = [
      msg('i1', 'weekly@minocquabrewing.com', 1),
      msg('i2', 'daily@minocquabrewing.com', 1),
    ];
    const p = popover({ seed: 'minocquabrewing' });
    await p._onCheck();
    p._onConfirm();

    assert.strictEqual(calls.closePopover, 1);
    assert.deepStrictEqual(calls.addMailRule, [
      {
        accountId: 'imap',
        name: 'Junk mail containing "minocquabrewing"',
        conditionMode: 'all',
        conditions: [{ templateKey: 'from', comparatorKey: 'contains', value: 'minocquabrewing' }],
        actions: [{ templateKey: 'changeFolder', value: 'junk-id' }],
      },
    ]);
    assert.deepStrictEqual(
      calls.queueTasks,
      [['task:i1']],
      'the thread already in Junk is skipped'
    );
  },

  async 'popover: an expression pattern is stored without its slashes'() {
    const p = popover({ seed: '/minocqua.+@substack\\.com/' });
    await p._onCheck();
    p._onConfirm();
    assert.deepStrictEqual(calls.addMailRule[0].conditions[0], {
      templateKey: 'from',
      comparatorKey: 'matchesExpression',
      value: 'minocqua.+@substack\\.com',
    });
    assert.strictEqual(calls.addMailRule[0].name, 'Junk mail matching /minocqua.+@substack\\.com/');
  },

  async 'popover: an invalid expression reports an error and saves nothing'() {
    const p = popover({ seed: '/([/' });
    await p._onCheck();
    assert.strictEqual(p.state.phase, 'editing');
    assert.ok(textOf(p.render()).includes('Invalid regular expression'), textOf(p.render()));
    assert.strictEqual(calls.addMailRule.length, 0);
  },

  async 'popover: empty text asks for input'() {
    const p = popover({ seed: '   ' });
    await p._onCheck();
    assert.ok(textOf(p.render()).includes('Enter some text to match.'));
    assert.strictEqual(calls.addMailRule.length, 0);
  },

  async 'popover: no matches still offers to create the rule'() {
    const p = popover({ seed: 'nobody' });
    await p._onCheck();
    const text = textOf(p.render());
    assert.ok(text.includes('Nothing in your Inbox matches'), text);
    assert.ok(text.includes('Create rule'), text);
    p._onConfirm();
    assert.strictEqual(calls.addMailRule.length, 1);
    assert.deepStrictEqual(calls.queueTasks, []);
  },

  async 'popover: an identical pattern rule is not created twice'() {
    rules = [
      {
        accountId: 'imap',
        conditions: [{ templateKey: 'from', comparatorKey: 'contains', value: 'MinocquaBrewing' }],
        actions: [{ templateKey: 'changeFolder', value: 'junk-id' }],
      },
    ];
    dbThreads = [thread('i1', 'imap', [], ['inbox-id'], 1)];
    messages = [msg('i1', 'weekly@minocquabrewing.com', 1)];
    const p = popover({ seed: 'minocquabrewing' });
    await p._onCheck();
    p._onConfirm();
    assert.deepStrictEqual(calls.addMailRule, [], 'rule already exists');
    assert.deepStrictEqual(calls.queueTasks, [['task:i1']], 'but existing mail still moves');
  },

  async 'popover: Escape closes, Enter checks then confirms'() {
    dbThreads = [thread('i1', 'imap', [], ['inbox-id'], 1)];
    messages = [msg('i1', 'weekly@minocquabrewing.com', 1)];
    const p = popover({ seed: 'minocquabrewing' });

    p._onKeyDown({ key: 'Escape', preventDefault() {} });
    assert.strictEqual(calls.closePopover, 1);

    p._onKeyDown({ key: 'Enter', preventDefault() {} });
    for (let i = 0; i < 20 && p.state.phase !== 'checked'; i++) await flush();
    assert.strictEqual(p.state.phase, 'checked');

    p._onKeyDown({ key: 'Enter', preventDefault() {} });
    assert.strictEqual(calls.addMailRule.length, 1);
    assert.deepStrictEqual(calls.queueTasks, [['task:i1']]);
  },

  async 'popover: editing the text clears an earlier result'() {
    const p = popover({ seed: 'minocquabrewing' });
    await p._onCheck();
    p._onChange({ target: { value: 'minocqua' } });
    assert.strictEqual(p.state.phase, 'editing');
    assert.deepStrictEqual(p.state.matches, []);
    assert.ok(textOf(p.render()).includes('Check matches'));
  },

  async 'hidden for Gmail (label) accounts'() {
    messages = [msg('t1', 'new@spam.com', 2)];
    const b = await mount([thread('t1', 'gmail')]);
    assert.strictEqual(b.render(), null);
  },

  async 'hidden when every message is from me'() {
    messages = [msg('t1', 'me@me.com', 2, true)];
    const b = await mount([thread('t1', 'imap')]);
    assert.strictEqual(b.render(), null);
  },

  async 'thread already in Junk: creates the rule but queues no move'() {
    messages = [msg('t1', 'new@spam.com', 2)];
    const b = await mount([thread('t1', 'imap', [{ role: 'spam' }])]);
    await click(b);
    assert.strictEqual(calls.addMailRule.length, 1);
    assert.deepStrictEqual(calls.queueTasks, []);
    assert.strictEqual(calls.popSheet, 0);
  },

  async 'multi-select: one rule per sender, threads from same sender grouped'() {
    messages = [msg('t1', 'a@spam.com', 1), msg('t2', 'b@spam.com', 1), msg('t3', 'A@spam.com', 1)];
    const b = await mount([thread('t1', 'imap'), thread('t2', 'imap'), thread('t3', 'imap')]);
    assert.strictEqual(
      b.render().props.title,
      `Always move mail from these 2 senders to Junk${INBOX_SUFFIX}${SHIFT_HINT}`
    );
    await click(b);
    assert.deepStrictEqual(
      calls.addMailRule.map((r) => r.conditions[0].value),
      ['a@spam.com', 'b@spam.com']
    );
    assert.deepStrictEqual(calls.queueTasks, [['task:t1,t3,t2']]);
  },

  async 'selection change refreshes; unmount unsubscribes'() {
    messages = [msg('t1', 'a@spam.com', 1), msg('t2', 'b@spam.com', 1)];
    const b = await mount([thread('t1', 'imap')]);
    const prevProps = b.props;
    b.props = { items: [thread('t2', 'imap')] };
    b.componentDidUpdate(prevProps);
    await flush();
    assert.ok(b.render().props.title.startsWith('Always move mail from b@spam.com'));
    b.componentWillUnmount();
    assert.strictEqual(listener, null);
  },

  async 'main registers as a ThreadActionsToolbarButton'() {
    main.activate();
    assert.deepStrictEqual(calls.registered, [
      [JunkSenderButton, { role: 'ThreadActionsToolbarButton' }],
    ]);
    main.deactivate();
    assert.deepStrictEqual(calls.unregistered, [JunkSenderButton]);
    assert.strictEqual(JunkSenderButton.displayName, 'JunkSenderButton');
    assert.strictEqual(JunkSenderButton.containerRequired, false);
  },
};

(async () => {
  let failed = 0;
  for (const [name, fn] of Object.entries(tests)) {
    reset();
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL  ${name}\n      ${err.message.split('\n').join('\n      ')}`);
    }
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
