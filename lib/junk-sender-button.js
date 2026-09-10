const {
  React,
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
const { RetinaImg } = require('mailspring-component-kit');

// A funnel, since the button creates a filter rule. Mask mode only uses the alpha channel and
// tints it with the toolbar's icon color. 16x16 matches the built-in toolbar icons.
const ICON_URL = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
    '<path d="M1.5 2.5h13l-5 6v4.5l-3 1.5v-6z"/></svg>'
)}`;

// Label-based (Gmail) accounts only offer label actions in the rule editor, so a folder rule
// would show there as "Could not find template".
function spamFolderFor(accountId) {
  const account = AccountStore.accountForId(accountId);
  if (!account || account.usesLabels()) return null;
  return CategoryStore.getSpamCategory(accountId);
}

function isJunkRule(rule, accountId, email, folderId) {
  const [condition] = rule.conditions;
  return (
    rule.accountId === accountId &&
    rule.conditions.length === 1 &&
    condition.templateKey === 'from' &&
    condition.comparatorKey === 'equals' &&
    (condition.value || '').toLowerCase() === email &&
    rule.actions.some((a) => a.templateKey === 'changeFolder' && a.value === folderId)
  );
}

// A thread's sender is the author of its newest message not sent by the user. Thread
// participants aren't used because they include everyone CC'd on the conversation.
async function sendersFor(threads) {
  const messages = await DatabaseStore.findAll(Message, { threadId: threads.map((t) => t.id) });
  const rules = MailRulesStore.rules();
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
      const hasRule = rules.some((r) => isJunkRule(r, thread.accountId, email, folder.id));
      senders.set(key, { accountId: thread.accountId, email, folder, hasRule, threads: [] });
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
  const fromSender = new Set(
    messages
      .filter((m) => m.from.some((c) => (c.email || '').toLowerCase() === email))
      .map((m) => m.threadId)
  );
  return candidates.filter((t) => fromSender.has(t.id));
}

function selectionKey(threads) {
  return threads.map((t) => t.id).join(',');
}

class JunkSenderButton extends React.Component {
  static displayName = 'JunkSenderButton';
  static containerRequired = false;

  state = { senders: [] };

  componentDidMount() {
    this._unlisten = MailRulesStore.listen(() => this._refresh());
    this._refresh();
  }

  componentDidUpdate(prevProps) {
    if (selectionKey(prevProps.items) !== selectionKey(this.props.items)) {
      this._refresh();
    }
  }

  componentWillUnmount() {
    this._unmounted = true;
    this._unlisten();
  }

  async _refresh() {
    const key = selectionKey(this.props.items);
    const senders = await sendersFor(this.props.items);
    // Discard results for a selection that changed while the query ran.
    if (!this._unmounted && key === selectionKey(this.props.items)) {
      this.setState({ senders });
    }
  }

  _onClick = async (event) => {
    event.stopPropagation();
    const senders = await sendersFor(this.props.items);
    const inboxThreads = await Promise.all(senders.map(inboxThreadsFrom));

    for (const { accountId, email, folder } of senders.filter((s) => !s.hasRule)) {
      Actions.addMailRule({
        accountId,
        name: `Junk mail from ${email}`,
        conditionMode: 'all',
        conditions: [{ templateKey: 'from', comparatorKey: 'equals', value: email }],
        actions: [{ templateKey: 'changeFolder', value: folder.id }],
      });
    }

    const threadsById = new Map();
    for (const t of [].concat(...senders.map((s) => s.threads), ...inboxThreads)) {
      threadsById.set(t.id, t);
    }
    const threads = [...threadsById.values()].filter(
      (t) => !t.folders.some((f) => f.role === 'spam')
    );
    if (threads.length > 0) {
      Actions.queueTasks(
        TaskFactory.tasksForMarkingAsSpam({ source: 'Toolbar Button: Junk Sender', threads })
      );
      Actions.popSheet();
    }
  };

  render() {
    const { senders } = this.state;
    if (senders.length === 0) {
      return null;
    }

    const folderName = senders[0].folder.displayName;
    const who = senders.length === 1 ? senders[0].email : `these ${senders.length} senders`;
    const title = senders.every((s) => s.hasRule)
      ? `Move mail from ${who} that's in your Inbox to ${folderName}. A rule already filters their new mail.`
      : `Always move mail from ${who} to ${folderName}, including what's already in your Inbox`;

    return React.createElement(
      'button',
      {
        tabIndex: -1,
        className: 'btn btn-toolbar',
        title,
        'aria-label': title,
        onClick: this._onClick,
      },
      React.createElement(RetinaImg, {
        url: ICON_URL,
        mode: RetinaImg.Mode.ContentIsMask,
        'aria-hidden': 'true',
      })
    );
  }
}

module.exports = JunkSenderButton;
