const {
  Actions,
  Thread,
  Message,
  AccountStore,
  CategoryStore,
  DatabaseStore,
  MailRulesStore,
  SearchQueryParser,
  TaskFactory,
} = require('mailspring-exports');

const SOURCE = 'Toolbar Button: Junk Sender';
const SCAN_PAGE_SIZE = 500;
const SCAN_THREAD_LIMIT = 20000;
const SAMPLE_SENDER_LIMIT = 50;

// Label-based (Gmail) accounts only offer label actions in the rule editor, so a folder rule
// would show there as "Could not find template".
function spamFolderFor(accountId) {
  const account = AccountStore.accountForId(accountId);
  if (!account || account.usesLabels()) return null;
  return CategoryStore.getSpamCategory(accountId);
}

// Mail rules compare the `from` condition against the sender's name as well as the address,
// so every matcher here tests both fields the same way.
function exactMatcher(email) {
  const address = (email || '').toLowerCase();
  return {
    comparatorKey: 'equals',
    value: address,
    describe: `from ${address}`,
    test: (...fields) => fields.some((f) => f && f.toLowerCase() === address),
  };
}

function containsMatcher(text) {
  const needle = text.toLowerCase();
  return {
    comparatorKey: 'contains',
    value: text,
    describe: `containing "${text}"`,
    test: (...fields) => fields.some((f) => f && f.toLowerCase().includes(needle)),
  };
}

// The rule processor evaluates stored expressions case-insensitively, so mirror that here.
function regexMatcher(source) {
  const re = new RegExp(source, 'i');
  return {
    comparatorKey: 'matchesExpression',
    value: source,
    describe: `matching /${source}/`,
    test: (...fields) => fields.some((f) => f && re.test(f)),
  };
}

// `/…/` is a regular expression, anything else is a case-insensitive substring. Throws on an
// invalid expression so callers can report it instead of saving a rule that can never run.
function matcherFor(pattern) {
  const text = (pattern || '').trim();
  const expression = /^\/(.+)\/[a-z]*$/.exec(text);
  return expression ? regexMatcher(expression[1]) : containsMatcher(text);
}

function matcherForCondition(condition) {
  const value = condition.value || '';
  if (condition.comparatorKey === 'equals') return exactMatcher(value);
  if (condition.comparatorKey === 'contains') return containsMatcher(value);
  if (condition.comparatorKey === 'matchesExpression') {
    try {
      return regexMatcher(value);
    } catch (err) {
      return null; // a rule holding a broken expression cannot cover anything
    }
  }
  return null;
}

function junkRules(accountId, folderId) {
  return MailRulesStore.rules().filter(
    (rule) =>
      rule.accountId === accountId &&
      rule.conditions.length === 1 &&
      rule.conditions[0].templateKey === 'from' &&
      rule.actions.some((a) => a.templateKey === 'changeFolder' && a.value === folderId)
  );
}

// True when some rule already sends this sender to Junk, whether it names the address
// outright or covers it with a substring or an expression.
function isCoveredByJunkRule({ accountId, folderId, email, name }) {
  return junkRules(accountId, folderId).some((rule) => {
    const matcher = matcherForCondition(rule.conditions[0]);
    return !!matcher && matcher.test(email, name);
  });
}

function junkRuleExistsFor(accountId, folderId, matcher) {
  return junkRules(accountId, folderId).some(
    (rule) =>
      rule.conditions[0].comparatorKey === matcher.comparatorKey &&
      (rule.conditions[0].value || '').toLowerCase() === matcher.value.toLowerCase()
  );
}

function createJunkRule(accountId, folder, matcher) {
  Actions.addMailRule({
    accountId,
    name: `Junk mail ${matcher.describe}`,
    conditionMode: 'all',
    conditions: [
      { templateKey: 'from', comparatorKey: matcher.comparatorKey, value: matcher.value },
    ],
    actions: [{ templateKey: 'changeFolder', value: folder.id }],
  });
}

// A thread's sender is the author of its newest message not sent by the user. Thread
// participants aren't used because they include everyone CC'd on the conversation.
async function sendersFor(threads) {
  const messages = await DatabaseStore.findAll(Message, { threadId: threads.map((t) => t.id) });
  const senders = new Map();

  for (const thread of threads) {
    const folder = spamFolderFor(thread.accountId);
    if (!folder) continue;

    const from = messages
      .filter((m) => m.threadId === thread.id)
      .sort((a, b) => b.date - a.date)
      .map((m) => m.from[0])
      .find((c) => c && c.email && !c.isMe());
    if (!from) continue;

    const email = from.email.toLowerCase();
    const key = `${thread.accountId}:${email}`;
    if (!senders.has(key)) {
      senders.set(key, {
        accountId: thread.accountId,
        email,
        name: from.name,
        folder,
        hasRule: isCoveredByJunkRule({
          accountId: thread.accountId,
          folderId: folder.id,
          email,
          name: from.name,
        }),
        threads: [],
      });
    }
    senders.get(key).threads.push(thread);
  }
  return [...senders.values()];
}

// Candidates come from the search index, the same lookup as searching `from:"email"`, which
// matches by word prefix. Each candidate is confirmed by the actual sender of its messages.
async function inboxThreadsFrom({ accountId, email }) {
  const inbox = CategoryStore.getInboxCategory(accountId);
  if (!inbox) return [];

  const candidates = await DatabaseStore.findAll(Thread, { accountId })
    .where(Thread.attributes.categories.contains(inbox.id))
    .structuredSearch(SearchQueryParser.parse(`from:"${email.replace(/"/g, '')}"`));
  if (candidates.length === 0) return [];

  const messages = await DatabaseStore.findAll(Message, {
    threadId: candidates.map((t) => t.id),
  });
  const matcher = exactMatcher(email);
  const hits = new Set(
    messages
      .filter((m) => (m.from || []).some((c) => c && matcher.test(c.email)))
      .map((m) => m.threadId)
  );
  return candidates.filter((t) => hits.has(t.id));
}

// A substring can sit anywhere in an address, which the word-prefix search index cannot find,
// so patterns are resolved by paging through the Inbox instead. Queries run through the
// background database agent to keep the UI responsive.
async function scanInbox({ accountId, matcher, onProgress }) {
  const inbox = CategoryStore.getInboxCategory(accountId);
  if (!inbox) return { threads: [], senders: [], scanned: 0, truncated: false };

  const threads = [];
  const senders = new Set();
  const seen = new Set();
  let scanned = 0;
  let cutoff = null;
  let truncated = false;

  for (;;) {
    let query = DatabaseStore.findAll(Thread, { accountId })
      .where(Thread.attributes.categories.contains(inbox.id))
      .order(Thread.attributes.lastMessageReceivedTimestamp.descending())
      .limit(SCAN_PAGE_SIZE)
      .background();
    if (cutoff !== null) {
      query = query.where(Thread.attributes.lastMessageReceivedTimestamp.lessThanOrEqualTo(cutoff));
    }

    const rows = await query;
    if (rows.length === 0) break;

    // Paging by timestamp repeats threads that share a page boundary, so drop the ones
    // already counted; a page of nothing but repeats means the end of the Inbox.
    const page = rows.filter((t) => !seen.has(t.id));
    if (page.length === 0) break;
    for (const t of page) seen.add(t.id);

    const messages = await DatabaseStore.findAll(Message, {
      threadId: page.map((t) => t.id),
    }).background();
    const hits = new Set();
    for (const message of messages) {
      for (const contact of message.from || []) {
        if (contact && matcher.test(contact.email, contact.name)) {
          hits.add(message.threadId);
          if (senders.size < SAMPLE_SENDER_LIMIT && contact.email) {
            senders.add(contact.email.toLowerCase());
          }
        }
      }
    }
    threads.push(...page.filter((t) => hits.has(t.id)));

    scanned += page.length;
    if (onProgress) onProgress({ scanned, matched: threads.length });

    cutoff = page[page.length - 1].lastMessageReceivedTimestamp;
    if (scanned >= SCAN_THREAD_LIMIT) {
      truncated = true;
      break;
    }
  }

  return { threads, senders: [...senders], scanned, truncated };
}

function queueMove(threads) {
  const byId = new Map();
  for (const t of threads) byId.set(t.id, t);
  const movable = [...byId.values()].filter((t) => !t.folders.some((f) => f.role === 'spam'));
  if (movable.length === 0) return 0;

  Actions.queueTasks(TaskFactory.tasksForMarkingAsSpam({ source: SOURCE, threads: movable }));
  Actions.popSheet();
  return movable.length;
}

// Plain click: one rule per selected sender, plus their Inbox mail.
async function junkSenders(senders) {
  const inboxThreads = await Promise.all(senders.map(inboxThreadsFrom));

  for (const sender of senders.filter((s) => !s.hasRule)) {
    createJunkRule(sender.accountId, sender.folder, exactMatcher(sender.email));
  }

  return queueMove([].concat(...senders.map((s) => s.threads), ...inboxThreads));
}

// Shift-click: one rule for the pattern, plus the Inbox threads the scan matched.
function junkPattern({ accountId, folder, matcher, threads }) {
  if (!junkRuleExistsFor(accountId, folder.id, matcher)) {
    createJunkRule(accountId, folder, matcher);
  }
  return queueMove(threads);
}

module.exports = {
  spamFolderFor,
  exactMatcher,
  matcherFor,
  isCoveredByJunkRule,
  junkRuleExistsFor,
  sendersFor,
  inboxThreadsFrom,
  scanInbox,
  junkSenders,
  junkPattern,
};
