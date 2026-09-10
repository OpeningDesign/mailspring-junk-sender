// Loads the real plugin code with stubbed Mailspring modules and checks its behavior.
const Module = require('module');
const assert = require('assert');
const path = require('path');

const PLUGIN = path.join(__dirname, '..', 'lib');

let rules = [];
let messages = [];
let dbThreads = [];
let parsedQueries = [];
let listener = null;
const calls = { addMailRule: [], queueTasks: [], popSheet: 0, registered: [], unregistered: [] };
const accounts = { imap: { usesLabels: () => false }, gmail: { usesLabels: () => true } };
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
  attributes: { categories: { contains: (id) => (t) => t.categories.includes(id) } },
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
  }
  where(matcher) {
    this.matchers.push(matcher);
    return this;
  }
  structuredSearch(parsed) {
    this.parsed = parsed;
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
    return dbThreads.filter(
      (t) =>
        t.accountId === this.whereClause.accountId &&
        this.matchers.every((m) => m(t)) &&
        (!this.parsed || ftsFromMatches(t, this.parsed))
    );
  }
}

const stubs = {
  'mailspring-exports': {
    React: { Component, createElement: (type, props, ...children) => ({ type, props, children }) },
    Actions: {
      addMailRule: (r) => calls.addMailRule.push(r),
      queueTasks: (t) => calls.queueTasks.push(t),
      popSheet: () => calls.popSheet++,
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
const main = require(`${PLUGIN}/main.js`);

const contact = (email, me = false) => ({ email, isMe: () => me });
const msg = (threadId, email, date, me) => ({
  threadId,
  from: [contact(email, me)],
  date: new Date(date),
});
const thread = (id, accountId, folders = [], categories = []) => ({
  id,
  accountId,
  folders,
  categories,
});
const flush = () => new Promise((r) => setImmediate(r));
const click = (b) => b._onClick({ stopPropagation() {} });
const INBOX_SUFFIX = ", including what's already in your Inbox";
function reset() {
  rules = [];
  messages = [];
  dbThreads = [];
  parsedQueries = [];
  calls.addMailRule = [];
  calls.queueTasks = [];
  calls.popSheet = 0;
}

async function mount(items) {
  const b = new JunkSenderButton({ items });
  b.componentDidMount();
  await flush();
  return b;
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
    assert.strictEqual(el.props.title, `Always move mail from new@spam.com to Junk${INBOX_SUFFIX}`);
    assert.strictEqual(el.props.className, 'btn btn-toolbar');
    assert.ok(el.children[0].props.url.startsWith('data:image/svg+xml,'));
    assert.strictEqual(el.children[0].props.mode, 'mask');
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
      thread('t6', 'imap', [], ['inbox-id']), // sender replied to by a friend later: moved
    ];
    messages = [
      msg('t1', 'new@spam.com', 5),
      msg('t2', 'New@Spam.com', 1),
      msg('t3', 'new@spam.com.evil.net', 1),
      msg('t4', 'new@spam.com', 1),
      msg('t5', 'new@spam.com', 1),
      msg('t6', 'new@spam.com', 1),
      msg('t6', 'friend@x.com', 2),
    ];
    const b = await mount([selected]);
    await click(b);
    assert.deepStrictEqual(parsedQueries, ['from:"new@spam.com"']);
    assert.deepStrictEqual(calls.queueTasks, [['task:t1,t2,t6']]);
    assert.strictEqual(calls.addMailRule.length, 1);
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
      "Move mail from new@spam.com that's in your Inbox to Junk. A rule already filters their new mail."
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
    assert.strictEqual(
      b.render().props.title,
      `Always move mail from these 2 senders to Junk${INBOX_SUFFIX}`
    );
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
      `Always move mail from these 2 senders to Junk${INBOX_SUFFIX}`
    );
    await click(b);
    assert.deepStrictEqual(
      calls.addMailRule.map((r) => r.conditions[0].value),
      ['a@spam.com', 'b@spam.com']
    );
    assert.deepStrictEqual(parsedQueries, ['from:"a@spam.com"', 'from:"b@spam.com"']);
    assert.deepStrictEqual(calls.queueTasks, [['task:t1,t3,t2']]);
  },

  async 'selection change refreshes; unmount unsubscribes'() {
    messages = [msg('t1', 'a@spam.com', 1), msg('t2', 'b@spam.com', 1)];
    const b = await mount([thread('t1', 'imap')]);
    const prevProps = b.props;
    b.props = { items: [thread('t2', 'imap')] };
    b.componentDidUpdate(prevProps);
    await flush();
    assert.strictEqual(
      b.render().props.title,
      `Always move mail from b@spam.com to Junk${INBOX_SUFFIX}`
    );
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
