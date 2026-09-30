import { defineFrontComponent } from 'twenty-sdk/define';
import {
  msg,
  t,
  openSidePanelPage,
  SidePanelPages,
  useColorScheme,
  useUserId,
} from 'twenty-sdk/front-component';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RestApiClient } from 'twenty-client-sdk/rest';
// Named imports only: `useIcons` and `IconsProvider` drag in the whole Tabler
// set, several megabytes of it. twenty-ui re-exports a curated subset, and the
// per-format `IconFileTypePdf` family is not part of it — those are drawn
// below. These two are, and a link is exactly what they mean.
import { IconBrandGoogle, IconFile, IconLink } from 'twenty-ui/icon';

import { ACTIVITY_FEED_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER } from 'src/constants/universal-identifiers';
// Pure text handling, kept out of here so it can be tested without the SDK.
import { announce, flattenTables } from 'src/lib/announce';

// These were application variables once, editable from the app's Settings tab.
// The host injects such values into a front component still encrypted —
// `enc:v2:<workspace>:<blob>` — and nothing in twenty-sdk or twenty-client-sdk
// decrypts them, so nothing an admin typed ever arrived. Treating a ciphertext
// as a value is what turned SHOW_ATTACHMENTS off and kept every file out of the
// feed. They are constants until Twenty decrypts them.
//
// Thirty seconds, not fifteen. The panel stays open all day, and each cycle
// parses a few hundred kilobytes of JSON into objects the sandbox then has to
// collect — that churn is what made Safari reclaim the tab.
const POLL_INTERVAL_MS = 60 * 1000;
// Tasks and Buzz each pull a page of records plus a page of the edit events
// that make up their comment threads — four requests that were the two most
// expensive polls in the app. Twenty-five of each is more than a side panel
// shows before scrolling.
const TAB_PAGE_SIZE = 25;
// The tab pages like the feed does, and stops at the same ceiling. A hundred
// open tasks is already more than anybody works through in a sitting; past
// that the count tells the truth and the CRM's own list is the right tool.
const TASK_LIMIT = 100;
// A panel left open on a second screen should not poll all day. After this long
// without a touch the loop goes quiet, and the next click inside the panel
// wakes it and refreshes at once — so idle time costs a timer tick, not a
// request.
const IDLE_PAUSE_MS = 5 * 60 * 1000;
// Every tick asks one cheap question first — "has anything happened at all?" —
// for about 2 KB, and only pays for the tab's real payload when the answer is
// yes. A quiet workspace is the common case, and the Buzz tab alone costs
// 424 KB a poll without this.
const PROBE_LIMIT = 1;
// Some of what the panel shows changes with the clock rather than with the
// data — a task falls overdue, a timestamp turns into "2h". So the probe can
// suppress a fetch for this long at most, and staleness stays bounded.
const FULL_REFRESH_EVERY_MS = 10 * 60 * 1000;
// What the feed holds, deliberately fixed. Paging further back turned the
// panel into an archive nobody scrolled: a hundred latest events is what a
// person actually catches up on, and one request keeps them exact — no gaps
// between pages, no duplicates when a new event arrives mid-scroll.
const FEED_LIMIT = 100;
// The feed is a week of work: the denominator under it is the number of
// updates in that week, and it does not move as pages are loaded.
const FEED_WINDOW_DAYS = 7;
const FEED_PAGE_SIZE = 20;

// Service rows of our own object are excluded by the server, so the count it
// returns is the same number the panel would show — no silent discrepancy.
//
// Filtered by target rather than by `name`: Twenty dropped the flat `name`
// column from timelineActivity (gone by 2.35, twenty_bells#1) and the RAW_JSON
// replacement only supports `is`/`like`, not `startsWith`.
const feedFilter = () =>
  `happensAt[gte]:${new Date(
    Date.now() - FEED_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()},targetFeedReadStateId[is]:NULL`;
// Links are looked up for the whole page of records, and a record can carry
// several — so they get a wider budget than the page itself.
const LINK_PAGE_SIZE = Math.min(FEED_LIMIT * 2, 200);

// An import or a bulk edit produces the same event on dozens of records at
// once. One row per record buries everything else, so a burst of identical
// events by one person collapses into a single line.
const BULK_THRESHOLD = 5;
const BULK_WINDOW_MS = 5 * 60 * 1000;

// Attaching a file emits no timeline event at all — verified against a live
// instance. Declared here (rather than by `toAttachmentEvent`, further down,
// which sets it) so the helpers just below can special-case it.
const ATTACHMENT_EVENT = 'linked-attachment.created';

// created/updated/deleted/… used to be the second half of a dotted `name`
// like `note.updated`; it now lives on `timelineActivityTypeSnapshot`.
const getSnapshot = (item: TimelineRecord) =>
  (item.timelineActivityTypeSnapshot ?? null) as {
    name?: string;
    action?: string;
  } | null;

const getEventAction = (item: TimelineRecord): string =>
  item.name === ATTACHMENT_EVENT ? 'created' : (getSnapshot(item)?.action ?? '');

// `<kind>Linked` / `<kind>Unlinked` (`noteLinked`, `taskLinked`, …) replaces
// the old `linked-<kind>.<action>` name.
const getLinkedKind = (item: TimelineRecord): string | null => {
  if (item.name === ATTACHMENT_EVENT) {
    return 'attachment';
  }

  const name = getSnapshot(item)?.name ?? '';

  if (name.endsWith('Linked')) {
    return name.slice(0, -'Linked'.length);
  }

  if (name.endsWith('Unlinked')) {
    return name.slice(0, -'Unlinked'.length);
  }

  return null;
};

const ACTION_LABELS = {
  created: msg('created'),
  updated: msg('updated'),
  deleted: msg('deleted'),
} as const;

// Russian overrides for the standard objects; everything else (including every
// custom object) takes its label from the workspace's own object metadata.
const OBJECT_LABELS = {
  person: msg('Person'),
  company: msg('Company'),
  opportunity: msg('Opportunity'),
  task: msg('Task'),
  note: msg('Note'),
} as const;

// Attaching a note or a task to a record emits `linked-<kind>.<action>`, whose
// target is the record and whose `linkedRecordCachedName` is the note title.
// This is how comments on a record surface in the timeline.
const LINKED_KIND_LABELS = {
  note: msg('comment'),
  task: msg('task'),
  attachment: msg('document'),
} as const;

const LINKED_ACTION_LABELS = {
  created: msg('added'),
  updated: msg('edited'),
  deleted: msg('removed'),
} as const;

// Twenty's own palette (twenty-ui/theme MAIN_COLORS_LIGHT, converted from
// display-p3), matched to the colours the sidebar already gives each object.
// Object metadata carries no colour field, so this mapping is the only way to
// agree with what the app renders.
const OBJECT_COLORS: Record<string, string> = {
  company: '#4662D5', // blue
  person: '#5B5BCF', // iris
  opportunity: '#D45453', // red
  task: '#55A271', // green
  note: '#51A185', // jade
};

// twenty-ui MAIN_COLORS_LIGHT, converted from display-p3. SELECT options in
// field metadata reference these by name.
const ACCENT_BLUE = '#4662D5';

const THEME_COLORS: Record<string, string> = {
  red: '#D45453',
  ruby: '#D45268',
  crimson: '#D74C81',
  tomato: '#D4583B',
  orange: '#E67333',
  amber: '#FFC442',
  yellow: '#FFEB38',
  lime: '#C7ED77',
  grass: '#61A560',
  green: '#55A271',
  jade: '#51A185',
  mint: '#9EE8D5',
  turquoise: '#4CA294',
  cyan: '#48A0C3',
  sky: '#95E0FB',
  blue: '#4662D5',
  iris: '#5B5BCF',
  violet: '#6A57C8',
  purple: '#8551C0',
  plum: '#9F50B5',
  pink: '#C64C9C',
  bronze: '#9C8174',
  gold: '#948469',
  brown: '#A6815E',
  gray: '#999999',
};

// Custom objects (dostavki, reklamacii, …) get a stable colour from this
// fallback ring, keyed by the object name so it never shifts between rows.
// Deliberately none of the colours used by the standard objects above.
const FALLBACK_OBJECT_COLORS = [
  '#E67333', // orange
  '#8551C0', // purple
  '#C64C9C', // pink
  '#4CA294', // turquoise
  '#FFEB38', // yellow
];

type TimelineRecord = Record<string, unknown>;

type FeedGroup = { key: string; items: TimelineRecord[] };

// REST answers with the rows plus how many there are in total and where the
// page ended — that is what makes "loaded 96 of 199" and paging possible.
type Page<K extends string> = {
  data?: Partial<Record<K, TimelineRecord[]>>;
  totalCount?: number;
  pageInfo?: { endCursor?: string; hasNextPage?: boolean };
};

// The server's cursor is nothing but the sort key of the last row, base64'd —
// verified byte-for-byte against `pageInfo.endCursor`. Building it from the
// oldest row we already hold means paging never depends on a `pageInfo` that
// may not survive a poll, and it repairs itself after any refresh.
const cursorFor = (item: TimelineRecord) =>
  btoa(JSON.stringify({ happensAt: item.happensAt, id: item.id }));

const isVisibleEvent = (item: TimelineRecord) => {
  if (
    typeof item.targetFeedReadStateId === 'string' &&
    item.targetFeedReadStateId !== ''
  ) {
    return false;
  }

  // An update whose every changed field is bookkeeping — or reports the same
  // value on both sides — leaves a card with a heading, a chip and nothing
  // underneath. Something happened to the record, but there is nothing in it
  // for a reader. Creations carry no diff at all by design and stay.
  if (getEventAction(item) === 'updated') {
    return extractDiff(item.properties).length > 0;
  }

  return true;
};

type FieldMeta = {
  label: string;
  options?: Record<string, { label: string; color: string }>;
};

type ResolvedTarget = {
  objectNameSingular: string;
  recordId: string;
  label: string;
  avatarUrl?: string;
};

const readDisplayName = (record: unknown): string => {
  if (record === null || typeof record !== 'object') {
    return '';
  }

  const { name, title } = record as { name?: unknown; title?: unknown };

  if (typeof name === 'string') {
    return name;
  }

  if (name !== null && typeof name === 'object') {
    const { firstName, lastName } = name as {
      firstName?: string;
      lastName?: string;
    };

    return [firstName, lastName].filter(Boolean).join(' ');
  }

  return typeof title === 'string' ? title : '';
};

const readMemberId = (value: unknown): string | undefined => {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }

  const { workspaceMemberId, id } = value as {
    workspaceMemberId?: unknown;
    id?: unknown;
  };

  if (typeof workspaceMemberId === 'string' && workspaceMemberId !== '') {
    return workspaceMemberId;
  }

  return typeof id === 'string' && id !== '' ? id : undefined;
};

const readAvatarUrl = (record: unknown): string | undefined => {
  if (record === null || typeof record !== 'object') {
    return undefined;
  }

  const { avatarUrl } = record as { avatarUrl?: unknown };

  return typeof avatarUrl === 'string' && avatarUrl !== '' ? avatarUrl : undefined;
};

// Both the object type and the record id come from whichever `target<Object>Id`
// is filled in — deliberately not from the event name. `linked-note.created`
// carries `targetCompanyId`, so trusting the event name would build the route
// /object/linked-note/<company id>. Reading the raw REST payload also makes
// custom objects — dostavki, reklamacii — resolvable without naming them.
const resolveTarget = (item: TimelineRecord): ResolvedTarget | null => {
  const idEntry = Object.entries(item).find(
    ([key, value]) =>
      key.startsWith('target') &&
      key.endsWith('Id') &&
      typeof value === 'string' &&
      value !== '',
  );

  if (idEntry === undefined) {
    return null;
  }

  const relationKey = idEntry[0].slice(0, -2);
  const bare = relationKey.slice('target'.length);

  return {
    objectNameSingular: bare.charAt(0).toLowerCase() + bare.slice(1),
    recordId: idEntry[1] as string,
    label: readDisplayName(item[relationKey]),
    avatarUrl: readAvatarUrl(item[relationKey]),
  };
};

// Twenty nulls the foreign key when a record is destroyed, so an event about
// something deleted points at nothing: no name to show, nothing to open. The
// row it produced said "record deleted, cannot open" and struck its own title
// through — a tombstone, not news.
const pointsAtALivingRecord = (item: TimelineRecord) =>
  resolveTarget(item) !== null;

// Attaching a file emits no timeline event at all — verified against a live
// instance. Attachments carry their own `target<Object>Id` and `createdAt`,
// so they are read separately and folded into the feed as synthetic events.
const toAttachmentEvent = (attachment: TimelineRecord): TimelineRecord => ({
  ...attachment,
  id: `attachment-${String(attachment.id)}`,
  name: ATTACHMENT_EVENT,
  happensAt: attachment.createdAt,
  linkedRecordCachedName: attachment.name,
  properties: null,
});

const GOOGLE_DRIVE_HOSTS = ['drive.google.com', 'docs.google.com'];

// One glyph for every format. Per-extension icons turned the strip into a
// sticker sheet, and Twenty's own pack has no per-format family anyway — a
// link is the only thing worth telling apart, because it is not a file.
const getFileIcon = (fileName: string) => {
  const name = fileName.toLowerCase();

  if (!name.startsWith('http')) {
    return IconFile;
  }

  return GOOGLE_DRIVE_HOSTS.some((host) => name.includes(host))
    ? IconBrandGoogle
    : IconLink;
};

const readMarkdown = (body: unknown) => {
  if (body === null || typeof body !== 'object') {
    return '';
  }

  const { markdown } = body as { markdown?: unknown };

  return typeof markdown === 'string' ? markdown : '';
};

// An edit either appends to the note (a comment) or rewrites it. Only the
// appended part is worth showing — that is the thing that was actually said.
const readNoteEdit = (event: TimelineRecord) => {
  const diff = (
    event.properties as { diff?: { bodyV2?: { before?: unknown; after?: unknown } } } | null
  )?.diff?.bodyV2;

  const before = readMarkdown(diff?.before);
  const after = readMarkdown(diff?.after);

  if (after !== '' && after.startsWith(before)) {
    return { text: after.slice(before.length).trim(), isRewrite: false, before };
  }

  return { text: after.trim(), isRewrite: true, before };
};

// The note as it stood when the comment was written: its last paragraphs.
// `before` is the exact body at that moment, so the context is reconstructed
// precisely rather than guessed from the current text.
const readContextBefore = (before: string, paragraphs = 2) => {
  const blocks = before
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== '');

  return blocks.slice(-paragraphs);
};

const isRichTextValue = (value: unknown) =>
  value !== null && typeof value === 'object' && 'markdown' in value;

// Ninety characters of a pasted table is ninety characters of pipes, so the
// scaffolding comes out before anything is measured.
const truncate = (text: string, limit = 90) => {
  const flat = flattenTables(text);

  return flat.length > limit ? `${flat.slice(0, limit).trimEnd()}…` : flat;
};

// A rich-text diff is two whole documents. Neither is worth printing in a feed
// row — what changed is.
const describeRichTextChange = (beforeRaw: unknown, afterRaw: unknown) => {
  const before = readMarkdown(beforeRaw);
  const after = readMarkdown(afterRaw);

  if (before === after) {
    return t('no change');
  }

  if (before === '') {
    return t('text added: {text}', { text: truncate(after) });
  }

  if (after === '') {
    return t('text removed');
  }

  if (after.startsWith(before)) {
    return t('appended: {text}', { text: truncate(after.slice(before.length).trim()) });
  }

  if (before.startsWith(after)) {
    return t('text shortened');
  }

  return t('rewritten: {text}', { text: truncate(after) });
};

const byHappensAtDesc = (a: TimelineRecord, b: TimelineRecord) =>
  new Date(String(b.happensAt)).getTime() -
  new Date(String(a.happensAt)).getTime();

// Diff values arrive as raw column payloads: plain scalars, composites
// (FULL_NAME, CURRENCY, ACTOR) and relations reduced to { id }. Dumping JSON
// at the user is not an option.
// Raw ISO timestamps are unreadable in a diff line. When the value carries no
// meaningful time of day, the date alone is enough.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

const formatDateValue = (value: string) => {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const stamp = `${day}.${month}.${date.getFullYear()}`;

  if (date.getHours() === 0 && date.getMinutes() === 0) {
    return stamp;
  }

  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  return `${stamp}, ${hours}:${minutes}`;
};

const formatValue = (
  value: unknown,
  memberNames: Record<string, string>,
): string => {
  if (value === null || value === undefined || value === '') {
    return '—';
  }

  if (typeof value === 'string' && ISO_DATE.test(value)) {
    return formatDateValue(value);
  }

  if (typeof value !== 'object') {
    return String(value);
  }

  const record = value as Record<string, unknown>;

  // ACTOR — createdBy / updatedBy and friends.
  if (typeof record.name === 'string' && record.name !== '') {
    return record.name;
  }

  // FULL_NAME
  const composedName = [record.firstName, record.lastName]
    .filter((part) => typeof part === 'string' && part !== '')
    .join(' ');

  if (composedName !== '') {
    return composedName;
  }

  // CURRENCY
  if (typeof record.amountMicros === 'number') {
    const amount = record.amountMicros / 1_000_000;

    return `${amount} ${String(record.currencyCode ?? '')}`.trim();
  }

  // LINKS / EMAILS / PHONES keep the primary value up front.
  const primary =
    record.primaryLinkUrl ?? record.primaryEmail ?? record.primaryPhoneNumber;

  if (typeof primary === 'string' && primary !== '') {
    return primary;
  }

  // A relation, reduced to its id — resolvable when it points at a teammate.
  if (typeof record.id === 'string') {
    return memberNames[record.id] ?? '—';
  }

  return '—';
};

// Bookkeeping fields change on every single write, so their diffs are noise.
const HIDDEN_DIFF_FIELDS = [
  'updatedBy',
  'createdBy',
  'updatedAt',
  'createdAt',
  'deletedAt',
  'position',
  'searchVector',
];

// properties is RAW_JSON — the server puts a { diff: { field: { before, after } } }
// payload there on `updated` events, and an empty object on `created`.
const extractDiff = (properties: unknown) => {
  const diff = (properties as { diff?: Record<string, unknown> } | null)?.diff;

  if (!diff || typeof diff !== 'object') {
    return [];
  }

  return Object.entries(diff)
    .filter(([field]) => !HIDDEN_DIFF_FIELDS.includes(field))
    .map(([field, change]) => {
      const { before, after } = (change ?? {}) as {
        before?: unknown;
        after?: unknown;
      };

      return { field, beforeRaw: before, afterRaw: after };
    })
    // A field the server reports as changed while both sides are equal has
    // nothing to show, and "title: Report → Report" reads like a bug.
    //
    // Rich text needs comparing by its text: a body re-saved unchanged still
    // differs as JSON, because every block is reissued with a fresh id, and
    // that produced rows reading "Body: no change".
    .filter(({ beforeRaw, afterRaw }) => {
      if (isRichTextValue(beforeRaw) && isRichTextValue(afterRaw)) {
        return readMarkdown(beforeRaw) !== readMarkdown(afterRaw);
      }

      try {
        return JSON.stringify(beforeRaw) !== JSON.stringify(afterRaw);
      } catch {
        return true;
      }
    });
};

const formatAgo = (isoDate: string) => {
  const minutes = Math.floor((Date.now() - new Date(isoDate).getTime()) / 60_000);

  if (minutes < 1) {
    return t('just now');
  }

  if (minutes < 60) {
    return t('{minutes}m', { minutes });
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return t('{hours}h', { hours });
  }

  return t('{days}d', { days: Math.floor(hours / 24) });
};

const DAY_MS = 24 * 60 * 60 * 1000;

const describeDue = (dueAt: unknown) => {
  if (typeof dueAt !== 'string' || dueAt === '') {
    return { label: t('no due date'), overdueDays: 0, sortKey: Number.MAX_SAFE_INTEGER };
  }

  const due = new Date(dueAt).getTime();
  const days = Math.floor((Date.now() - due) / DAY_MS);

  if (days > 0) {
    return {
      label: t('{days}d overdue', { days }),
      overdueDays: days,
      sortKey: due,
    };
  }

  if (days === 0) {
    return { label: t('today'), overdueDays: 0, sortKey: due };
  }

  return { label: t('in {days}d', { days: -days }), overdueDays: 0, sortKey: due };
};

const getObjectColor = (objectNameSingular: string) => {
  const known = OBJECT_COLORS[objectNameSingular];

  if (known !== undefined) {
    return known;
  }

  let hash = 0;

  for (let index = 0; index < objectNameSingular.length; index++) {
    hash = (hash * 31 + objectNameSingular.charCodeAt(index)) % 100_000;
  }

  return FALLBACK_OBJECT_COLORS[hash % FALLBACK_OBJECT_COLORS.length];
};

const getInitials = (value: string) =>
  value
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

const getPalette = (colorScheme: 'light' | 'dark') =>
  colorScheme === 'dark'
    ? {
        text: '#E8E8E8',
        textMid: '#A8A8A8',
        textLight: '#7E7E7E',
        border: '#282828',
        rail: '#333333',
        hover: '#1F1F1F',
        buttonBackground: 'rgba(255, 255, 255, 0.06)',
        // A card under the cursor is marked by its outline alone — the fill
        // stays flat so the feed does not flicker as the pointer crosses it.
        cardHoverBorder: 'rgba(149, 224, 251, 0.24)',
        // twenty-ui `sky`, the softest blue in the palette: enough to mark a
        // row as unread, not enough to shout over the text.
        unread: 'rgba(149, 224, 251, 0.09)',
        unreadHover: 'rgba(149, 224, 251, 0.16)',
        mutedFill: '#3A3A3A',
        mutedGlyph: '#8F8F8F',
      }
    : {
        // twenty-ui FONT_LIGHT tokens: primary / secondary / tertiary.
        text: '#333333',
        textMid: '#666666',
        textLight: '#999999',
        border: '#EDEDED',
        rail: '#E3E3E3',
        hover: '#0000000A',
        buttonBackground: 'rgba(0, 0, 0, 0.035)',
        cardHoverBorder: 'rgba(70, 98, 213, 0.26)',
        unread: 'rgba(149, 224, 251, 0.16)',
        unreadHover: 'rgba(149, 224, 251, 0.28)',
        mutedFill: '#F0F0F0',
        mutedGlyph: '#999999',
      };

const InlineAvatar = ({
  label,
  color,
  textColor,
  avatarUrl,
  size,
}: {
  label: string;
  color: string;
  textColor: string;
  avatarUrl?: string;
  size: number;
}) => {
  if (avatarUrl !== undefined) {
    return (
      <img
        src={avatarUrl}
        alt=""
        style={{
          width: `${size}px`,
          height: `${size}px`,
          borderRadius: '3px',
          objectFit: 'cover',
          flexShrink: 0,
        }}
      />
    );
  }

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: '3px',
        background: color,
        color: textColor,
        fontSize: `${Math.round(size * 0.5)}px`,
        fontWeight: 500,
        flexShrink: 0,
      }}
    >
      {getInitials(label) || '?'}
    </span>
  );
};

const ToolbarButton = ({
  label,
  title,
  onClick,
  background,
  color,
  isActive,
  activeColor,
}: {
  label: string;
  title?: string;
  onClick: () => void;
  background: string;
  color: string;
  isActive?: boolean;
  activeColor?: string;
}) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    aria-pressed={isActive}
    style={{
      padding: '4px 9px',
      borderRadius: '4px',
      whiteSpace: 'nowrap',
      flexShrink: 0,
      border:
        isActive === true
          ? `1px solid ${activeColor ?? color}`
          : '1px solid transparent',
      background: isActive === true ? 'transparent' : background,
      color: isActive === true ? (activeColor ?? color) : color,
      fontSize: '0.85rem',
      fontWeight: isActive === true ? 500 : 400,
      cursor: 'pointer',
      fontFamily: 'inherit',
    }}
  >
    {label}
  </button>
);

const ActivityFeed = () => {
  const colorScheme = useColorScheme();
  const palette = getPalette(colorScheme);
  const userId = useUserId();

  const [items, setItems] = useState<TimelineRecord[]>([]);
  const [objectLabels, setObjectLabels] = useState<Record<string, string>>({});
  const [fieldMeta, setFieldMeta] = useState<Record<string, FieldMeta>>({});
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [expandedComments, setExpandedComments] = useState<string[]>([]);
  const [expandedThreads, setExpandedThreads] = useState<string[]>([]);
  // Cards keep their own hover state: the inner rows and comments share
  // `hoveredId`, and their onMouseLeave would otherwise clear the card's
  // highlight while the cursor is still inside it.
  const [hoveredCard, setHoveredCard] = useState<string | null>(null);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [myCompanyIds, setMyCompanyIds] = useState<string[]>([]);
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const [memberAvatars, setMemberAvatars] = useState<Record<string, string>>({});
  const [view, setView] = useState<'feed' | 'tasks' | 'buzz'>('feed');
  const [tasks, setTasks] = useState<TimelineRecord[]>([]);
  // Every task assigned to the reader that is not done — the whole workspace,
  // not the loaded page. Null until the viewer is known.
  const [assignedOpenCount, setAssignedOpenCount] = useState<number | null>(null);
  const [notes, setNotes] = useState<TimelineRecord[]>([]);
  const [noteEdits, setNoteEdits] = useState<TimelineRecord[]>([]);
  const [noteTargets, setNoteTargets] = useState<TimelineRecord[]>([]);
  const [taskEdits, setTaskEdits] = useState<TimelineRecord[]>([]);
  const [taskTargets, setTaskTargets] = useState<TimelineRecord[]>([]);
  const [lastSeenAt, setLastSeenAt] = useState<string | null>(null);
  const [readStateId, setReadStateId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [feedTotal, setFeedTotal] = useState(0);
  // Pages fetched behind the first one. Kept apart from `items` so the poll can
  // refresh the newest page without throwing away what the reader paged in.
  const [olderItems, setOlderItems] = useState<TimelineRecord[]>([]);
  const [isFeedExhausted, setIsFeedExhausted] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [taskLimit, setTaskLimit] = useState(TAB_PAGE_SIZE);
  // How many open tasks are the reader's in total, straight from the server —
  // the number the page is a slice of.
  const [myTaskTotal, setMyTaskTotal] = useState(0);
  // Which background loads are currently failing. Every one of them used to
  // fail in silence, and the panel simply showed less: no documents, no chips,
  // nobody's name. Both of the hardest bugs this app has had were invisible
  // for exactly that reason.
  const [degraded, setDegraded] = useState<string[]>([]);

  const noteFailure = useCallback((scope: string) => {
    setDegraded((scopes) => (scopes.includes(scope) ? scopes : [...scopes, scope]));
  }, []);

  const noteSuccess = useCallback((scope: string) => {
    setDegraded((scopes) =>
      scopes.includes(scope) ? scopes.filter((s) => s !== scope) : scopes,
    );
  }, []);
  // Files are refreshed with the links rather than on every poll: a hundred
  // attachments at depth 1 is a quarter-megabyte of JSON, and a document that
  // appears half a minute later is nobody's emergency.
  const [documentItems, setDocumentItems] = useState<TimelineRecord[]>([]);
  // A file filed under a contact says nothing about the business behind it, so
  // the card borrows context: the contact's company, and that company's live
  // deal. Kept as flat maps because that is all the chips need.
  const [companyNames, setCompanyNames] = useState<Record<string, string>>({});
  const [companyDeals, setCompanyDeals] = useState<
    Record<string, { id: string; name: string }>
  >({});
  // Refs, not state: a click must not re-create the polling interval, and the
  // interval must read the latest values without being rebuilt around them.
  const activeAtRef = useRef(Date.now());
  const pausedRef = useRef(false);
  const refreshRef = useRef<() => void>(() => {});
  const probeRef = useRef<{ topId: string; total: number } | null>(null);
  const lastFullLoadAtRef = useRef(0);
  const [isPaused, setIsPaused] = useState(false);

  const markActive = useCallback(() => {
    activeAtRef.current = Date.now();

    if (pausedRef.current) {
      pausedRef.current = false;
      setIsPaused(false);
      refreshRef.current();
    }
  }, []);

  // One request, one row, no relations: the id of the newest event plus the
  // count of the window. Both unchanged means nothing has happened since the
  // last look — the timeline is append-only, so an edit anywhere in the
  // workspace shows up here as a new top row.
  const probeForNews = useCallback(async () => {
    try {
      const probe = await new RestApiClient().get<Page<'timelineActivities'>>(
        '/rest/timelineActivities',
        {
          query: {
            filter: feedFilter(),
            limit: PROBE_LIMIT,
            depth: 0,
            order_by: 'happensAt[DescNullsLast]',
          },
        },
      );

      const total = probe.totalCount ?? 0;
      const topId = String(probe.data?.timelineActivities?.[0]?.id ?? '');

      // The denominator under the feed rides along for free.
      setFeedTotal(total);

      const seen = probeRef.current;

      probeRef.current = { topId, total };

      return seen === null || seen.topId !== topId || seen.total !== total;
    } catch {
      // A failed probe must not swallow the poll: fall through and fetch.
      return true;
    }
  }, []);

  const loadFeed = useCallback(async () => {
    try {
      const client = new RestApiClient();

      const timeline = await client.get<Page<'timelineActivities'>>(
        '/rest/timelineActivities',
        {
          query: {
            filter: feedFilter(),
            limit: FEED_PAGE_SIZE,
            depth: 1,
            order_by: 'happensAt[DescNullsLast]',
          },
        },
      );

      setItems(
        (timeline.data?.timelineActivities ?? []).filter(isVisibleEvent),
      );
      setFeedTotal(timeline.totalCount ?? 0);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsLoading(false);
    }
  }, []);

  // One page further back, never past the cap. Files do not page: they live in
  // their own strip with its own expander.
  const loadMore = async () => {
    const oldest = loadedEvents[loadedEvents.length - 1];

    if (oldest === undefined || loadedEvents.length >= FEED_LIMIT) {
      return;
    }

    setIsLoadingMore(true);

    try {
      const page = await new RestApiClient().get<Page<'timelineActivities'>>(
        '/rest/timelineActivities',
        {
          query: {
            filter: feedFilter(),
            // A whole page every time. Trimming the request to the remaining
            // room made the last clicks add one or two rows each; the hard cap
            // on `changes` does the trimming instead.
            limit: FEED_PAGE_SIZE,
            depth: 1,
            order_by: 'happensAt[DescNullsLast]',
            starting_after: cursorFor(oldest),
          },
        },
      );

      const fetched = (page.data?.timelineActivities ?? []).filter(isVisibleEvent);

      setIsFeedExhausted(fetched.length === 0);
      setOlderItems((prev) => [...prev, ...fetched]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsLoadingMore(false);
    }
  };

  // Custom objects should read by their own label, not their API name —
  // own metadata is the only place those labels exist.
  const loadObjectLabels = useCallback(async () => {
    try {
      const client = new RestApiClient();

      const response = await client.get<{
        data?: {
          objects?: {
            nameSingular: string;
            labelSingular: string;
            fields?: {
              name: string;
              label: string;
              options?: { value: string; label: string; color: string }[];
            }[];
          }[];
        };
      }>('/rest/metadata/objects', { query: { limit: 200 } });

      const objects = response.data?.objects ?? [];

      setObjectLabels(
        Object.fromEntries(
          objects.map((object) => [object.nameSingular, object.labelSingular]),
        ),
      );

      // SELECT options come with their own label and theme colour, which is
      // what turns `stage: NEW → MEETING` into the labels the record shows.
      setFieldMeta(
        Object.fromEntries(
          objects.flatMap((object) =>
            (object.fields ?? []).map((field) => [
              `${object.nameSingular}.${field.name}`,
              {
                label: field.label,
                options:
                  field.options === undefined
                    ? undefined
                    : Object.fromEntries(
                        field.options.map((option) => [
                          option.value,
                          { label: option.label, color: option.color },
                        ]),
                      ),
              },
            ]),
          ),
        ),
      );
      noteSuccess('object labels');
    } catch {
      // The feed falls back to raw object names, and says so.
      noteFailure('object labels');
    }
  }, []);

  // Who is looking. The app token carries the application's role, not the
  // viewer's, so the panel has to work out relevance itself.
  const loadViewer = useCallback(async () => {
    if (userId === null) {
      return;
    }

    try {
      const client = new RestApiClient();

      const members = await client.get<{
        data?: {
          workspaceMembers?: {
            id: string;
            userId?: string;
            name?: { firstName?: string; lastName?: string };
            avatarUrl?: string;
          }[];
        };
      }>('/rest/workspaceMembers', { query: { limit: 200 } });

      const allMembers = members.data?.workspaceMembers ?? [];

      setMemberNames(
        Object.fromEntries(
          allMembers.map((member) => [
            member.id,
            [member.name?.firstName, member.name?.lastName]
              .filter(Boolean)
              .join(' '),
          ]),
        ),
      );

      setMemberAvatars(
        Object.fromEntries(
          allMembers
            .filter((member) => (member.avatarUrl ?? '') !== '')
            .map((member) => [member.id, member.avatarUrl as string]),
        ),
      );

      // Asked for by id rather than looked up in the page above: the member
      // list is capped at two hundred, and in a workspace larger than that the
      // viewer may simply not be on it. Failing to place them used to mean
      // failing to filter.
      const self = await client.get<{
        data?: { workspaceMembers?: { id: string }[] };
      }>('/rest/workspaceMembers', {
        query: { filter: `userId[eq]:${userId}`, limit: 1 },
      });

      const id =
        self.data?.workspaceMembers?.[0]?.id ??
        allMembers.find((member) => member.userId === userId)?.id ??
        null;

      setMemberId(id);

      if (id === null) {
        return;
      }

      const companies = await client.get<{
        data?: { companies?: { id: string }[] };
      }>('/rest/companies', {
        query: { filter: `accountOwnerId[eq]:${id}`, limit: 200 },
      });

      setMyCompanyIds((companies.data?.companies ?? []).map((c) => c.id));
      noteSuccess('viewer');
    } catch {
      // Without a resolved member nothing can be judged relevant, so the panel
      // shows nothing at all — which has to be said out loud.
      noteFailure('viewer');
    }
  }, [userId]);

  // What a task or a note hangs on — a deal, a company, a contact. The to-many
  // link is not expanded on the record itself, so it is read separately.
  //
  // Only for the records actually on screen. Reading the two hundred newest
  // links blind cost 700 KB per call and kept every one of them alive in
  // memory; asking by id costs a few kilobytes and returns exactly what the
  // chips need.
  const loadLinks = useCallback(async (taskIds: string[], noteIds: string[]) => {
    try {
      const client = new RestApiClient();

      const [taskResponse, noteResponse] = await Promise.all([
        taskIds.length === 0
          ? Promise.resolve({ data: { taskTargets: [] } })
          : client.get<{ data?: { taskTargets?: TimelineRecord[] } }>(
              '/rest/taskTargets',
              {
                query: {
                  filter: `taskId[in]:[${taskIds.join(',')}]`,
                  limit: LINK_PAGE_SIZE,
                  depth: 1,
                },
              },
            ),
        noteIds.length === 0
          ? Promise.resolve({ data: { noteTargets: [] } })
          : client.get<{ data?: { noteTargets?: TimelineRecord[] } }>(
              '/rest/noteTargets',
              {
                query: {
                  filter: `noteId[in]:[${noteIds.join(',')}]`,
                  limit: LINK_PAGE_SIZE,
                  // The chip is named from the linked record, which only comes
                  // with the relation expanded — same as taskTargets above.
                  // Without it every note chip read "Opportunity", "Company".
                  depth: 1,
                },
              },
            ),
      ]);

      setTaskTargets(taskResponse.data?.taskTargets ?? []);
      setNoteTargets(noteResponse.data?.noteTargets ?? []);
      noteSuccess('links');
    } catch {
      noteFailure('links');
    }
  }, []);

  // Two lookups by id, the same shape as the links: whatever is on screen, and
  // nothing more. A closed deal is skipped — the point is what is live now.
  const loadContext = useCallback(async (companyIds: string[]) => {
    if (companyIds.length === 0) {
      setCompanyNames({});
      setCompanyDeals({});

      return;
    }

    try {
      const client = new RestApiClient();
      const filter = `id[in]:[${companyIds.join(',')}]`;

      const [companies, deals] = await Promise.all([
        client.get<{ data?: { companies?: TimelineRecord[] } }>(
          '/rest/companies',
          { query: { filter, limit: LINK_PAGE_SIZE, depth: 0 } },
        ),
        client.get<{ data?: { opportunities?: TimelineRecord[] } }>(
          '/rest/opportunities',
          {
            query: {
              filter: `companyId[in]:[${companyIds.join(',')}]`,
              limit: LINK_PAGE_SIZE,
              depth: 0,
              order_by: 'createdAt[DescNullsLast]',
            },
          },
        ),
      ]);

      setCompanyNames(
        Object.fromEntries(
          (companies.data?.companies ?? []).map((company) => [
            String(company.id),
            typeof company.name === 'string' ? company.name : '',
          ]),
        ),
      );

      const live: Record<string, { id: string; name: string }> = {};

      for (const deal of deals.data?.opportunities ?? []) {
        const companyId = String(deal.companyId ?? '');
        const stage = String(deal.stage ?? '');

        if (
          companyId === '' ||
          live[companyId] !== undefined ||
          stage === 'WON' ||
          stage === 'LOST'
        ) {
          continue;
        }

        live[companyId] = {
          id: String(deal.id),
          name: typeof deal.name === 'string' ? deal.name : '',
        };
      }

      setCompanyDeals(live);
      noteSuccess('context');
    } catch {
      noteFailure('context');
    }
  }, []);

  const loadDocuments = useCallback(async () => {
    try {
      const response = await new RestApiClient().get<{
        data?: { attachments?: TimelineRecord[] };
      }>('/rest/attachments', {
        // At fifty the newest files were all on contacts and companies, and
        // documents filed under tasks or notes never showed up.
        query: {
          limit: FEED_LIMIT,
          depth: 1,
          order_by: 'createdAt[DescNullsLast]',
        },
      });

      setDocumentItems(
        (response.data?.attachments ?? []).map(toAttachmentEvent),
      );
      noteSuccess('documents');
    } catch {
      noteFailure('documents');
    }
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const client = new RestApiClient();

      if (memberId === null) {
        setTasks([]);
        setTaskEdits([]);
        setAssignedOpenCount(null);

        return;
      }

      // Asked of the server, not sorted out afterwards. A page of twenty-five
      // taken off eighteen hundred tasks by due date is twenty-five tasks
      // belonging to whoever happens to be at the front of that queue: the
      // reader's own could be absent from it entirely, and one with no due
      // date sorts last and never appears at all.
      const mine =
        `status[neq]:DONE,or(assigneeId[eq]:${memberId},` +
        `createdBy.workspaceMemberId[eq]:${memberId})`;

      const [response, assignedResponse] = await Promise.all([
        // depth 0: the assignee is needed as a name, and `assigneeId` plus the
        // member map already give that — the nested record was four fifths of
        // this response.
        client.get<Page<'tasks'>>('/rest/tasks', {
          query: {
            filter: mine,
            limit: taskLimit,
            depth: 0,
            order_by: 'dueAt[AscNullsLast]',
          },
        }),
        // The badge is a count, not a list: asking the server for one row and
        // reading `totalCount` costs under two kilobytes and is exact, where
        // counting the loaded page would top out at TAB_PAGE_SIZE.
        client.get<Page<'tasks'>>('/rest/tasks', {
          query: {
            filter: `assigneeId[eq]:${memberId},status[neq]:DONE`,
            limit: 1,
            depth: 0,
          },
        }),
      ]);

      const mineOnPage = response.data?.tasks ?? [];

      setTasks(mineOnPage);
      setMyTaskTotal(response.totalCount ?? mineOnPage.length);
      setAssignedOpenCount(assignedResponse?.totalCount ?? null);

      // A task body can be amended exactly like a note body, which is the only
      // comment mechanism a task has — notes cannot be linked to tasks. Asked
      // for by task id: the newest twenty-five edits in the workspace are
      // rarely the edits on these twenty-five tasks.
      const ids = mineOnPage.map((task) => String(task.id));

      if (ids.length === 0) {
        setTaskEdits([]);

        return;
      }

      // `name[eq]:task.updated` no longer resolves (twenty_bells#1) — filtered
      // by target only, then narrowed to updates client-side.
      const editsResponse = await client.get<{
        data?: { timelineActivities?: TimelineRecord[] };
      }>('/rest/timelineActivities', {
        query: {
          filter: `targetTaskId[in]:[${ids.join(',')}]`,
          limit: LINK_PAGE_SIZE,
          depth: 0,
          order_by: 'happensAt[DescNullsLast]',
        },
      });

      setTaskEdits(
        (editsResponse.data?.timelineActivities ?? [])
          .filter((edit) => getEventAction(edit) === 'updated')
          .reverse(),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [memberId, taskLimit]);

  // Buzz: notes as posts, and every later edit of a note body as a comment.
  // Twenty has no comment object — amending the note text is the mechanism —
  // so the thread is reconstructed from `note.updated` diffs.
  const loadBuzz = useCallback(async () => {
    try {
      const client = new RestApiClient();

      const [notesResponse, editsResponse] = await Promise.all([
        // depth 0: a post needs its own columns — title, body, createdBy,
        // timestamps — and its links arrive separately as noteTargets.
        client.get<{ data?: { notes?: TimelineRecord[] } }>('/rest/notes', {
          query: {
            limit: TAB_PAGE_SIZE,
            depth: 0,
            order_by: 'createdAt[DescNullsLast]',
          },
        }),
        // `name[eq]:note.updated` no longer resolves (twenty_bells#1) —
        // narrowed to updates client-side instead.
        client.get<{ data?: { timelineActivities?: TimelineRecord[] } }>(
          '/rest/timelineActivities',
          {
            query: {
              filter: 'targetNoteId[is]:NOT_NULL',
              limit: TAB_PAGE_SIZE,
              depth: 0,
              // Newest first, because that is the end the limit cuts. Asking
              // ascending meant the page held the oldest edits in the
              // workspace and the recent comments fell off it.
              order_by: 'happensAt[DescNullsLast]',
            },
          },
        ),
      ]);

      setNotes(notesResponse.data?.notes ?? []);
      // Threads are read oldest-first downstream, so the page goes back the
      // way it came.
      setNoteEdits(
        (editsResponse.data?.timelineActivities ?? [])
          .filter((edit) => getEventAction(edit) === 'updated')
          .reverse(),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  const loadReadState = useCallback(async () => {
    if (userId === null) {
      return;
    }

    try {
      const client = new RestApiClient();

      const response = await client.get<{
        data?: { feedReadStates?: { id: string; lastSeenAt?: string }[] };
      }>('/rest/feedReadStates', {
        query: { filter: `userId[eq]:${userId}`, limit: 1 },
      });

      const state = response.data?.feedReadStates?.[0];

      setReadStateId(state?.id ?? null);
      setLastSeenAt(state?.lastSeenAt ?? null);
      noteSuccess('read marker');
    } catch {
      noteFailure('read marker');
    }
  }, [userId]);

  useEffect(() => {
    void loadReadState();
    void loadObjectLabels();
    void loadViewer();
  }, [loadReadState, loadObjectLabels, loadViewer]);

  // Files change rarely, so they ride the tab switch rather than the poll.
  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments, view]);

  // Only the tab in front of the user is polled. Refreshing all three every
  // 15 seconds meant 1.7 MB of JSON per cycle — most of it for screens nobody
  // was looking at, all of it parsed into objects the sandbox then collected.
  useEffect(() => {
    const fetchTab = () => {
      lastFullLoadAtRef.current = Date.now();

      if (view === 'tasks') {
        void loadTasks();
      } else if (view === 'buzz') {
        void loadBuzz();
      } else {
        void loadFeed();
      }
    };

    // Opening the panel or switching tabs is the user asking for the data —
    // that always pays in full. Only the timer haggles.
    const refresh = () => {
      void (async () => {
        const isStale =
          Date.now() - lastFullLoadAtRef.current >= FULL_REFRESH_EVERY_MS;

        if ((await probeForNews()) || isStale) {
          fetchTab();
        }
      })();
    };

    refreshRef.current = refresh;
    activeAtRef.current = Date.now();
    pausedRef.current = false;
    setIsPaused(false);
    fetchTab();
    // Seed the watermark, or the very first tick would see "no previous probe"
    // and pay for a page it already has.
    void probeForNews();

    // The tick itself is kept, only the work is skipped: resuming then costs
    // nothing to set up, and the timer is free next to a request.
    const intervalId = setInterval(() => {
      if (Date.now() - activeAtRef.current >= IDLE_PAUSE_MS) {
        pausedRef.current = true;
        setIsPaused(true);

        return;
      }

      refresh();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [view, loadFeed, loadTasks, loadBuzz, probeForNews]);

  const markAllAsRead = async () => {
    if (userId === null) {
      return;
    }

    const now = new Date().toISOString();
    const client = new RestApiClient();

    setLastSeenAt(now);

    if (readStateId !== null) {
      await client.patch(`/rest/feedReadStates/${readStateId}`, {
        lastSeenAt: now,
      });

      return;
    }

    const created = await client.post<{
      data?: { createFeedReadState?: { id: string } };
    }>('/rest/feedReadStates', { userId, lastSeenAt: now });

    setReadStateId(created.data?.createFeedReadState?.id ?? null);
  };

  // The SDK cannot scroll to a position inside a record — no anchor, offset or
  // block id anywhere in the front-component API. EditRichText is the closest
  // thing: it opens the note's body instead of the record overview, and since
  // comments are appended the newest text sits at the end of it.
  const openRecord = (target: ResolvedTarget) => {
    void openSidePanelPage({
      page: SidePanelPages.ViewRecord,
      recordId: target.recordId,
      objectNameSingular: target.objectNameSingular,
    });
  };

  const isUnread = (item: TimelineRecord) =>
    lastSeenAt === null ||
    new Date(String(item.happensAt)).getTime() > new Date(lastSeenAt).getTime();

  // Relevance, not security: this decides what is worth showing, it does not
  // stop the data reaching the browser. The app role is what actually governs
  // access, and it is workspace-wide.
  const isMine = (item: TimelineRecord) => {
    // Nobody's feed is everybody's feed. If the viewer cannot be placed in the
    // workspace there is no "mine" to compute, and showing the lot instead is
    // the opposite of what this panel is for.
    if (memberId === null) {
      return false;
    }

    // Anything you did is yours. Events made through the API carry no
    // workspaceMember, only the ACTOR in `createdBy` — reading just the first
    // of the two dropped every note and comment written over the API.
    if (
      item.workspaceMemberId === memberId ||
      readMemberId(item.createdBy) === memberId
    ) {
      return true;
    }

    // A note is addressed to the team by definition: it has no owner, and the
    // ones that matter most — the standalone ones — are filed under nothing at
    // all. Judging them by ownership kept every comment out of the feed, so
    // they are relevant to everyone, like a message on a board.
    const targetIsNote = resolveTarget(item)?.objectNameSingular === 'note';

    if (targetIsNote || getLinkedKind(item) === 'note') {
      return true;
    }

    // A task belongs to the two people it names: whoever set it and whoever has
    // to do it. Being filed under your deal does not make somebody else's task
    // yours — that is a question of what the deal shows, not of what your bell
    // should ring for.
    const task = item.targetTask as
      | { assigneeId?: unknown; createdBy?: unknown }
      | null
      | undefined;

    if (task !== null && task !== undefined) {
      return (
        task.assigneeId === memberId ||
        readMemberId(task.createdBy) === memberId
      );
    }

    const relationKey = Object.keys(item).find(
      (key) =>
        key.startsWith('target') && !key.endsWith('Id') && item[key] !== null,
    );
    const record = relationKey === undefined ? null : item[relationKey];

    if (record === null || typeof record !== 'object') {
      return false;
    }

    const { ownerId, accountOwnerId, assigneeId, companyId, id } =
      record as Record<string, unknown>;

    if (
      ownerId === memberId ||
      accountOwnerId === memberId ||
      assigneeId === memberId
    ) {
      return true;
    }

    if (typeof companyId === 'string' && myCompanyIds.includes(companyId)) {
      return true;
    }

    return typeof id === 'string' && myCompanyIds.includes(id);
  };

  // The newest page plus everything paged in behind it. Keyed by id: a poll can
  // land mid-scroll and serve the same event twice. Memoised because hovering a
  // card is a state change, and re-sorting on every mouse move is work nobody
  // asked for.
  const allItems = useMemo(
    () =>
      [
        ...new Map(
          [...items, ...olderItems, ...documentItems].map((item) => [
            String(item.id),
            item,
          ]),
        ).values(),
      ].sort(byHappensAtDesc),
    [items, olderItems, documentItems],
  );

  // The panel is personal, full stop. A toggle to "everything" made the counter
  // meaningless — a number under a feed that showed a fraction of it — and
  // nobody reads a workspace-wide firehose anyway. The variant with the switch
  // is kept on the backup/scope-toggle branch.
  //
  // This filter used to be skipped where the server appeared to scope the data
  // itself. It does not any more: server-side scoping can only ever narrow the
  // response further, so running the personal filter on top of it is always
  // safe, while trusting it was not.
  const visibleItems = useMemo(
    // Both filters belong here rather than at fetch time: attachments are
    // folded in as synthetic events and never pass through the timeline query.
    () => allItems.filter(pointsAtALivingRecord).filter(isMine),
    // `isMine` is rebuilt every render; what it actually reads is listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allItems, memberId, myCompanyIds],
  );

  // Tasks view: what is hanging, not what changed. Done tasks are dropped —
  // a finished task is never something the user still owes.
  const openTasks = tasks.filter((task) => {
    if (task.status === 'DONE') {
      return false;
    }

    // A task belongs to the two people it names. One with neither — no
    // assignee, set by somebody else — belongs to nobody here.
    return (
      memberId !== null &&
      (task.assigneeId === memberId ||
        readMemberId(task.createdBy) === memberId)
    );
  });

  const overdueTasks = openTasks
    .filter((task) => describeDue(task.dueAt).overdueDays > 0)
    .sort((a, b) => describeDue(a.dueAt).sortKey - describeDue(b.dueAt).sortKey);

  const upcomingTasks = openTasks
    .filter((task) => describeDue(task.dueAt).overdueDays === 0)
    .sort((a, b) => describeDue(a.dueAt).sortKey - describeDue(b.dueAt).sortKey);

  // A post keeps the text the note started with; everything appended later
  // becomes a comment under it.
  // A note that hangs on a deal belongs to that deal's story, not to the
  // team wall — Buzz keeps everything else.
  const noteIdsOnDeals = new Set(
    noteTargets
      .filter((link) => typeof link.targetOpportunityId === 'string')
      .map((link) => String(link.noteId)),
  );

  const buzzPosts = notes
    .filter((note) => !noteIdsOnDeals.has(String(note.id)))
    .map((note) => {
      const edits = noteEdits.filter(
        (edit) => edit.targetNoteId === note.id,
      );
      const comments = edits
        .map((edit) => ({ edit, parsed: readNoteEdit(edit) }))
        .filter(({ parsed }) => parsed.text !== '');

      const originalBody =
        comments.length > 0
          ? comments[0].parsed.before
          : readMarkdown(note.bodyV2);

      // A post is dated by the last thing that happened to it, not by the day
      // it was written: a note from Monday with an answer an hour ago belongs
      // at the top, showing "1h". Comments arrive oldest-first, so the last
      // one is the newest.
      const lastComment = comments[comments.length - 1]?.edit.happensAt;
      const touchedAt = [note.createdAt, note.updatedAt, lastComment]
        .filter((value): value is string => typeof value === 'string')
        .reduce((latest, value) =>
          new Date(value).getTime() > new Date(latest).getTime() ? value : latest,
        );

      return { note, comments, originalBody, touchedAt };
    })
    .filter(
      (post) =>
        post.comments.length > 0 ||
        post.originalBody !== '' ||
        typeof post.note.title === 'string',
    )
    .sort(
      (a, b) =>
        new Date(b.touchedAt).getTime() - new Date(a.touchedAt).getTime(),
    );

  // Several events on the same record collapse into one row: the newest is
  // shown, the rest hide behind a counter.
  const describeBulk = (item: TimelineRecord) => {
    const linkedKind = getLinkedKind(item);
    const subject = linkedKind !== null ? `linked-${linkedKind}` : '';
    const action = getEventAction(item);
    const target = resolveTarget(item);

    return {
      // The event subject has to stay in the key. A file attached to a deal and
      // the deal itself both resolve to `opportunity`, so without it a batch of
      // uploads merged into the deals row and was counted as deals.
      subject,
      objectNameSingular: target?.objectNameSingular ?? subject,
      action,
      author: String(
        item.workspaceMemberId ?? readMemberId(item.createdBy) ?? '',
      ),
      bucket: Math.floor(
        new Date(String(item.happensAt)).getTime() / BULK_WINDOW_MS,
      ),
    };
  };

  type FeedEntry =
    | { kind: 'group'; key: string; items: TimelineRecord[] }
    | { kind: 'bulk'; key: string; items: TimelineRecord[] };

  // Grouping walks the whole feed twice and sorts the result. It depends on
  // the events alone, so it is rebuilt when they change — not when a card
  // lights up under the cursor.
  // Every change event fetched, before the personal filter. This is what the
  // counter compares against the server's total and what paging walks back
  // from — the filtered list would page into a different place.
  const loadedEvents = useMemo(
    () => allItems.filter((item) => item.name !== ATTACHMENT_EVENT),
    [allItems],
  );

  // Which records the chips will actually be asked about. The signature keeps
  // the effect from refiring when the same set comes back in another order.
  const linkedIds = useMemo(() => {
    const taskIds = new Set<string>();
    const noteIds = new Set<string>();

    for (const item of allItems) {
      if (typeof item.targetTaskId === 'string' && item.targetTaskId !== '') {
        taskIds.add(item.targetTaskId);
      }

      if (typeof item.targetNoteId === 'string' && item.targetNoteId !== '') {
        noteIds.add(item.targetNoteId);
      }
    }

    for (const task of tasks) {
      taskIds.add(String(task.id));
    }

    for (const note of notes) {
      noteIds.add(String(note.id));
    }

    return { taskIds: [...taskIds].sort(), noteIds: [...noteIds].sort() };
  }, [allItems, tasks, notes]);

  const linkSignature = `${linkedIds.taskIds.join(',')}|${linkedIds.noteIds.join(',')}`;

  useEffect(() => {
    void loadLinks(linkedIds.taskIds, linkedIds.noteIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkSignature]);

  // Companies worth resolving: the ones a card points at directly, and the ones
  // behind the contacts it points at.
  const contextCompanyIds = useMemo(() => {
    const ids = new Set<string>();

    for (const item of allItems) {
      const direct = item.targetCompanyId;
      const viaPerson = (item.targetPerson as { companyId?: unknown } | null)
        ?.companyId;

      if (typeof direct === 'string' && direct !== '') {
        ids.add(direct);
      }

      if (typeof viaPerson === 'string' && viaPerson !== '') {
        ids.add(viaPerson);
      }
    }

    return [...ids].sort();
  }, [allItems]);

  const contextSignature = contextCompanyIds.join(',');

  useEffect(() => {
    void loadContext(contextCompanyIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextSignature]);

  // Files are grouped with everything else, so a record's card carries both
  // what changed on it and what was filed under it. A record with only files
  // still forms a card of its own.
  // The cap is enforced here as well as at fetch time: whatever arrives, the
  // feed never grows past FEED_LIMIT rows of change history.
  const changes = useMemo(() => {
    // The cap counts change events only; files ride along with the record they
    // belong to. Cutting them by the event window was tried and thrown away —
    // files are older than the latest edits, so it left one document out of a
    // hundred on screen.
    const events = visibleItems
      .filter((item) => item.name !== ATTACHMENT_EVENT)
      .slice(0, FEED_LIMIT);
    const files = visibleItems.filter((item) => item.name === ATTACHMENT_EVENT);

    return [...events, ...files].sort(byHappensAtDesc);
  }, [visibleItems]);

  // What the feed actually shows: after the personal filter and after the cap.
  const visibleEventCount = useMemo(
    () => changes.filter((item) => item.name !== ATTACHMENT_EVENT).length,
    [changes],
  );

  const entries = useMemo<FeedEntry[]>(() => {
  const bulkCounts = new Map<string, number>();

  for (const item of changes) {
    const { subject, objectNameSingular, action, author, bucket } =
      describeBulk(item);
    const key = `${subject}|${objectNameSingular}|${action}|${author}|${bucket}`;

    bulkCounts.set(key, (bulkCounts.get(key) ?? 0) + 1);
  }

  const bulkEntries: { key: string; items: TimelineRecord[] }[] = [];
  const bulkIndex = new Map<string, { key: string; items: TimelineRecord[] }>();
  const groups: FeedGroup[] = [];
  const groupIndex = new Map<string, FeedGroup>();

  for (const item of changes) {
    const { subject, objectNameSingular, action, author, bucket } =
      describeBulk(item);
    const bulkKey = `${subject}|${objectNameSingular}|${action}|${author}|${bucket}`;

    if ((bulkCounts.get(bulkKey) ?? 0) >= BULK_THRESHOLD) {
      const existingBulk = bulkIndex.get(bulkKey);

      if (existingBulk === undefined) {
        const entry = { key: bulkKey, items: [item] };

        bulkIndex.set(bulkKey, entry);
        bulkEntries.push(entry);
      } else {
        existingBulk.items.push(item);
      }

      continue;
    }

    const target = resolveTarget(item);
    const key =
      target !== null
        ? `${target.objectNameSingular}:${target.recordId}`
        : `event:${String(item.id)}`;
    const existing = groupIndex.get(key);

    if (existing === undefined) {
      const group = { key, items: [item] };

      groupIndex.set(key, group);
      groups.push(group);
    } else {
      existing.items.push(item);
    }
  }

  const newestOf = (items: TimelineRecord[]) =>
    Math.max(...items.map((i) => new Date(String(i.happensAt)).getTime()));

  return [
    ...groups.map((g) => ({ kind: 'group' as const, ...g })),
    ...bulkEntries.map((b) => ({ kind: 'bulk' as const, ...b })),
  ].sort((a, b) => newestOf(b.items) - newestOf(a.items));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changes]);

  const unreadCount = visibleItems.filter(isUnread).length;

  const unreadEntries = entries.filter((e) => e.items.some(isUnread));
  const readEntries = entries.filter((e) => !e.items.some(isUnread));

  // Standard objects read from our own catalogue so the wording matches the
  // rest of the panel; everything else — custom objects included — takes the
  // label the workspace gave it.
  const labelForObject = (objectNameSingular: string) => {
    const known = OBJECT_LABELS[objectNameSingular as keyof typeof OBJECT_LABELS];

    return known !== undefined
      ? t(known)
      : (objectLabels[objectNameSingular] ?? objectNameSingular ?? t('Record'));
  };

  const describe = (item: TimelineRecord) => {
    const action = getEventAction(item);
    const target = resolveTarget(item);
    // Events made through the API carry no workspaceMember — the ACTOR in
    // `createdBy` is the only attribution there is.
    const author =
      readDisplayName(item.workspaceMember) || readDisplayName(item.createdBy);

    // A `noteLinked`/`taskLinked`/… event (formerly `linked-note.created` and
    // friends) describes something attached to the target record rather than
    // a change of the record itself.
    const linkedKind = getLinkedKind(item);
    const linkedName =
      typeof item.linkedRecordCachedName === 'string'
        ? item.linkedRecordCachedName
        : '';

    const objectNameSingular = target?.objectNameSingular ?? linkedKind ?? '';

    return {
      target,
      author,
      linkedKind,
      linkedName,
      objectNameSingular,
      changes: extractDiff(item.properties),
      objectLabel: labelForObject(objectNameSingular),
      actionLabel: (() => {
        const verb = ACTION_LABELS[action as keyof typeof ACTION_LABELS];

        if (linkedKind === null) {
          return verb !== undefined ? t(verb) : action;
        }

        const kind = LINKED_KIND_LABELS[linkedKind as keyof typeof LINKED_KIND_LABELS];
        const linkVerb =
          LINKED_ACTION_LABELS[action as keyof typeof LINKED_ACTION_LABELS];

        return `${kind !== undefined ? t(kind) : linkedKind} ${
          linkVerb !== undefined ? t(linkVerb) : action
        }`;
      })(),
    };
  };

  // SELECT fields carry their own labels and theme colours in metadata, so a
  // stage change renders as the same coloured labels the record page shows.
  const renderFieldValue = (
    objectNameSingular: string,
    field: string,
    raw: unknown,
    fallback: string,
  ) => {
    const option = fieldMeta[`${objectNameSingular}.${field}`]?.options?.[
      String(raw)
    ];

    if (option === undefined) {
      return fallback;
    }

    const color = THEME_COLORS[option.color] ?? palette.textMid;

    return (
      <span
        style={{
          padding: '1px 7px',
          borderRadius: '4px',
          background: `${color}26`,
          color,
          fontWeight: 500,
          whiteSpace: 'nowrap',
        }}
      >
        {option.label}
      </span>
    );
  };

  const renderFileMark = (fileName: string) => {
    const Icon = getFileIcon(fileName);

    return <Icon size={16} stroke={1.7} color={palette.textLight} />;
  };

  const renderPayload = (
    item: TimelineRecord,
    described: ReturnType<typeof describe>,
    accentColor: string,
  ) => (
    <>
      {described.linkedKind !== null && described.linkedName !== '' && (
        <div
          style={{
            marginTop: '5px',
            paddingLeft: '8px',
            borderLeft: `2px solid ${accentColor}`,
            fontSize: '0.92rem',
            fontWeight: 400,
            color: palette.text,
            lineHeight: '1.5',
            overflowWrap: 'anywhere',
          }}
        >
          {described.linkedName}
        </div>
      )}

      {described.changes.map((change) => {
        // What somebody wrote is speech, not a field value. Buzz and Tasks
        // render it as a comment; the feed used to print the same text as
        // `Body: appended: …`, which read like a database column. Same content,
        // same quoted shape — the author is already on the line above.
        const written = isRichTextValue(change.beforeRaw) || isRichTextValue(change.afterRaw)
          ? readNoteEdit({
              properties: { diff: { bodyV2: { before: change.beforeRaw, after: change.afterRaw } } },
            } as TimelineRecord)
          : null;

        if (written !== null && written.text !== '') {
          return (
            <div
              key={change.field}
              style={{
                marginTop: '5px',
                paddingLeft: '8px',
                borderLeft: `2px solid ${palette.border}`,
                fontSize: '0.92rem',
                fontWeight: 400,
                color: palette.text,
                lineHeight: '1.55',
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
              }}
            >
              {written.isRewrite && (
                <span style={{ color: palette.textLight }}>
                  {t('rewrote the text')}{' '}
                </span>
              )}
              {written.text}
            </div>
          );
        }

        return (
        <div
          key={change.field}
          style={{
            marginTop: '4px',
            fontSize: '0.92rem',
            fontWeight: 400,
            color: palette.text,
            lineHeight: '1.6',
            overflowWrap: 'anywhere',
          }}
        >
          <span style={{ color: palette.textMid }}>
            {fieldMeta[`${described.objectNameSingular}.${change.field}`]
              ?.label ?? change.field}
            :{' '}
          </span>
          {isRichTextValue(change.beforeRaw) || isRichTextValue(change.afterRaw) ? (
            describeRichTextChange(change.beforeRaw, change.afterRaw)
          ) : (
            <>
          {renderFieldValue(
            described.objectNameSingular,
            change.field,
            change.beforeRaw,
            formatValue(change.beforeRaw, memberNames),
          )}
          <span style={{ color: palette.textLight }}> → </span>
          {renderFieldValue(
            described.objectNameSingular,
            change.field,
            change.afterRaw,
            formatValue(change.afterRaw, memberNames),
          )}
            </>
          )}
        </div>
        );
      })}
    </>
  );

  // Tasks and notes hang off the record they were filed under, and that
  // record — usually a deal — is what the reader is actually following.
  // A deal matters more than the contact it goes through, so it leads.
  const LINK_RANK: Record<string, number> = { opportunity: 0, company: 1 };

  // Context for a record that carries no link rows of its own: a contact lends
  // its company, a company lends the deal that is still open on it.
  const contextFor = (item: TimelineRecord): ResolvedTarget[] => {
    const viaPerson = (item.targetPerson as { companyId?: unknown } | null)
      ?.companyId;
    const companyId =
      typeof item.targetCompanyId === 'string' && item.targetCompanyId !== ''
        ? item.targetCompanyId
        : typeof viaPerson === 'string'
          ? viaPerson
          : '';

    if (companyId === '') {
      return [];
    }

    const chips: ResolvedTarget[] = [];
    const deal = companyDeals[companyId];

    if (deal !== undefined) {
      chips.push({
        objectNameSingular: 'opportunity',
        recordId: deal.id,
        label: deal.name,
      });
    }

    // The company itself is redundant on a card that already leads with it.
    if (item.targetCompanyId !== companyId && companyNames[companyId] !== undefined) {
      chips.push({
        objectNameSingular: 'company',
        recordId: companyId,
        label: companyNames[companyId],
      });
    }

    return chips;
  };

  const relatedRecords = (objectNameSingular: string, recordId: string) => {
    const rows =
      objectNameSingular === 'task'
        ? taskTargets.filter((link) => String(link.taskId) === recordId)
        : objectNameSingular === 'note'
          ? noteTargets.filter((link) => String(link.noteId) === recordId)
          : [];

    return rows
      .map((link) => resolveTarget(link))
      .filter((link): link is ResolvedTarget => link !== null)
      .sort(
        (a, b) =>
          (LINK_RANK[a.objectNameSingular] ?? 2) -
          (LINK_RANK[b.objectNameSingular] ?? 2),
      )
      .slice(0, 2);
  };

  // The newest thing that happened to a record — what dates its card and what
  // orders the feed. `newestOf` returns a number for sorting; this one returns
  // the timestamp itself, for display.
  const newestHappensAt = (items: TimelineRecord[]) =>
    items.reduce(
      (latest, item) =>
        new Date(String(item.happensAt)).getTime() >
        new Date(String(latest)).getTime()
          ? String(item.happensAt)
          : latest,
      String(items[0]?.happensAt ?? ''),
    );

  const renderHead = (
    item: TimelineRecord,
    unread: boolean,
    touchedAt?: string,
  ) => {
    const described = describe(item);
    const { target, author, objectLabel, actionLabel, objectNameSingular } =
      described;
    const isBroken = target === null;
    // Own links first — a task really is filed under that deal. Borrowed
    // context fills the gap for records that have none: a contact's company,
    // that company's open deal.
    const ownLinks = isBroken
      ? []
      : relatedRecords(objectNameSingular, String(target.recordId));
    const recordLinks =
      ownLinks.length > 0 ? ownLinks : contextFor(item).slice(0, 2);
    const isActive = unread && !isBroken;
    const classColor = getObjectColor(objectNameSingular);
    const chipLabel = !isBroken && target.label !== '' ? target.label : objectLabel;

    return (
      <div
        onClick={isBroken ? undefined : () => openRecord(target)}
        style={{
          display: 'flex',
          gap: '11px',
          padding: '10px 16px 0',
          cursor: isBroken ? 'default' : 'pointer',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: '10px',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                minWidth: 0,
                flexWrap: 'wrap',
              }}
            >
              {!isBroken && (
                <InlineAvatar
                  size={15}
                  label={chipLabel}
                  color={isActive ? `${classColor}22` : palette.mutedFill}
                  textColor={isActive ? classColor : palette.mutedGlyph}
                  avatarUrl={target.avatarUrl}
                />
              )}
              <span
                style={{
                  fontSize: '0.92rem',
                  // A card's heading is a heading whether or not it has been
                  // read; weight was carrying the unread state, which the tint
                  // now says on its own — and it left read cards looking faded.
                  fontWeight: 500,
                  color: isBroken ? palette.textLight : palette.text,
                  textDecoration: isBroken ? 'line-through' : 'none',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: '190px',
                }}
              >
                {chipLabel}
              </span>
            </div>

            <span
              style={{
                fontSize: '0.92rem',
                fontWeight: 400,
                color: palette.textLight,
                whiteSpace: 'nowrap',
              }}
            >
              {formatAgo(touchedAt ?? String(item.happensAt))}
            </span>
          </div>

          <div
            style={{
              marginTop: '2px',
              fontSize: '0.92rem',
              fontWeight: 400,
              // Secondary, not tertiary: what happened and who did it is the
              // sentence of the card. Tertiary grey is for the timestamp.
              color: palette.textMid,
              lineHeight: '1.5',
            }}
          >
            {objectLabel} · {actionLabel}
            {author !== '' && (
              <>
                {' · '}
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                    verticalAlign: 'middle',
                  }}
                >
                  <InlineAvatar
                    size={14}
                    label={author}
                    color={palette.mutedFill}
                    textColor={palette.textMid}
                    avatarUrl={
                      memberAvatars[
                        readMemberId(item.workspaceMember) ??
                          readMemberId(item.createdBy) ??
                          ''
                      ]
                    }
                  />
                  {author}
                </span>
              </>
            )}
            {isBroken && ` · ${t('record deleted, cannot open')}`}
          </div>

          {recordLinks.length > 0 && (
            <div
              style={{
                marginTop: '5px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                flexWrap: 'wrap',
                rowGap: '5px',
              }}
            >
              {recordLinks.map((link) => {
                const linkColor = getObjectColor(link.objectNameSingular);
                // A record can have no name — an untitled note, a company saved
                // blank. The chip still opens it, so it keeps its place and
                // borrows the object's own name instead of rendering as an
                // empty box with a question mark in it.
                const linkLabel =
                  link.label !== ''
                    ? link.label
                    : labelForObject(link.objectNameSingular);

                return (
                  <span
                    key={link.recordId}
                    onClick={(event) => {
                      event.stopPropagation();
                      openRecord(link);
                    }}
                    title={t('Open: {label}', { label: linkLabel })}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '5px',
                      maxWidth: '180px',
                      padding: '1px 7px 1px 3px',
                      borderRadius: '4px',
                      background: `${linkColor}14`,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <InlineAvatar
                      size={14}
                      label={linkLabel}
                      color={`${linkColor}2E`}
                      textColor={linkColor}
                      avatarUrl={link.avatarUrl}
                    />
                    <span
                      style={{
                        fontSize: '0.92rem',
                        color: palette.text,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {linkLabel}
                    </span>
                  </span>
                );
              })}
            </div>
          )}

          {renderPayload(item, described, isActive ? classColor : palette.rail)}
        </div>
      </div>
    );
  };

  const renderFollowUp = (item: TimelineRecord) => {
    const described = describe(item);

    return (
      <div
        key={String(item.id)}
        style={{
          padding: '8px 16px 0 13px',
          marginLeft: '16px',
          borderLeft: `2px solid ${palette.border}`,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: '10px',
          }}
        >
          {/* Most of what hides behind the counter is a creation, and a
              creation carries no diff at all — the row is its own content.
              Named and weighted like the head's own line, or expanding the
              card reads as nothing having happened. */}
          <span
            style={{
              fontSize: '0.92rem',
              fontWeight: 400,
              color: palette.textMid,
            }}
          >
            {described.objectLabel} · {described.actionLabel}
            {described.author !== '' ? ` · ${described.author}` : ''}
          </span>
          <span
            style={{
              fontSize: '0.92rem',
              fontWeight: 400,
              color: palette.textLight,
              whiteSpace: 'nowrap',
            }}
          >
            {formatAgo(String(item.happensAt))}
          </span>
        </div>
        {renderPayload(item, described, palette.rail)}
      </div>
    );
  };

  const renderGroup = (group: FeedGroup, unread: boolean) => {
    // Files are not "one more event on this record" — they are things you come
    // back to. They stay visible under the head instead of hiding behind the
    // counter, and a card made only of files leads with the newest one.
    const files = group.items.filter((item) => item.name === ATTACHMENT_EVENT);
    const events = group.items.filter((item) => item.name !== ATTACHMENT_EVENT);
    const [head, ...rest] = events.length > 0 ? events : files;
    const attachments = events.length > 0 ? files : files.slice(1);
    const isExpanded = expandedKeys.includes(group.key);

    // A feed row opens the record exactly like a card does, so it answers the
    // cursor the same way. A row has no frame to outline, so the reaction is a
    // fill — the standard list affordance — rather than the card's border.
    const isRowHovered = hoveredCard === group.key;
    const touchedAt = newestHappensAt(group.items);

    return (
      <div
        key={group.key}
        onMouseEnter={() => setHoveredCard(group.key)}
        onMouseLeave={() => setHoveredCard(null)}
        style={{
          margin: '16px 12px',
          border: `1px solid ${
            isRowHovered ? palette.cardHoverBorder : palette.border
          }`,
          borderRadius: '10px',
          // Unread keeps the tint; a read card sits on the panel's own surface.
          background: unread
            ? isRowHovered
              ? palette.unreadHover
              : palette.unread
            : colorScheme === 'dark'
              ? '#1B1B1B'
              : '#FFFFFF',
          overflow: 'hidden',
          transition: 'background 140ms ease, border-color 140ms ease',
        }}
      >
        <div style={{ paddingBottom: '12px' }}>
          {renderHead(head, unread, touchedAt)}
        </div>

        {/* Everything filed under the record sits on the same tinted strip a
            task card gives its comments: what happened above, what is attached
            to it below. Two surfaces of one anatomy, so the feed and the other
            tabs read as the same object. */}
        {(attachments.length > 0 || rest.length > 0) && (
          <div
            style={{
              borderTop: `1px solid ${palette.border}`,
              background: unread
                ? 'transparent'
                : colorScheme === 'dark'
                  ? '#191919'
                  : '#FAFAFA',
              padding: '8px 0 10px',
            }}
          >
            {attachments.length > 0 && (
          <div
            style={{
              padding: '0 16px',
            }}
          >
            {attachments.map((file) => {
              const fileName =
                typeof file.linkedRecordCachedName === 'string'
                  ? file.linkedRecordCachedName
                  : t('Document');

              // The SDK has no file viewer — its only modal is a text
              // confirmation, and no side-panel page renders a document. The
              // attachment is a record of its own, though, so the name opens
              // that record, where Twenty offers the file itself.
              const attachmentId = String(file.id).replace(/^attachment-/, '');

              return (
                <div
                  key={String(file.id)}
                  style={{
                    marginTop: '4px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    minWidth: 0,
                  }}
                >
                  {renderFileMark(fileName)}
                  <span
                    onClick={(event) => {
                      event.stopPropagation();
                      openRecord({
                        objectNameSingular: 'attachment',
                        recordId: attachmentId,
                        label: fileName,
                      });
                    }}
                    onMouseEnter={() => setHoveredId(`file-${attachmentId}`)}
                    onMouseLeave={() => setHoveredId(null)}
                    title={t('Open: {label}', { label: fileName })}
                    style={{
                      fontSize: '0.92rem',
                      fontWeight: 400,
                      color: palette.text,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      cursor: 'pointer',
                      textDecoration:
                        hoveredId === `file-${attachmentId}`
                          ? 'underline'
                          : 'none',
                    }}
                  >
                    {fileName}
                  </span>
                </div>
              );
            })}
          </div>
            )}

            {rest.length > 0 && (
          <div
            style={{
              padding: attachments.length > 0 ? '8px 16px 0' : '0 16px',
            }}
          >
            <button
              type="button"
              onClick={() =>
                setExpandedKeys((keys) =>
                  keys.includes(group.key)
                    ? keys.filter((key) => key !== group.key)
                    : [...keys, group.key],
                )
              }
              style={{
                border: 'none',
                background: 'transparent',
                padding: 0,
                fontFamily: 'inherit',
                fontSize: '0.92rem',
                fontWeight: 400,
                color: palette.textMid,
                cursor: 'pointer',
                textDecoration: 'underline',
              }}
            >
              {isExpanded
                ? t('Collapse')
                : rest.length === 1
                  ? t('1 more event on this record')
                  : t('{count} more events on this record', {
                      count: rest.length,
                    })}
            </button>
          </div>

            )}

            {isExpanded && rest.map(renderFollowUp)}
          </div>
        )}
      </div>
    );
  };


  const renderTask = (task: TimelineRecord) => {
    const due = describeDue(task.dueAt);
    const isOverdue = due.overdueDays > 0;
    // An empty string is a string: without this a nameless task drew a card
    // with a status, a date and no line saying what it was.
    const title =
      typeof task.title === 'string' && task.title.trim() !== ''
        ? task.title
        : t('Untitled');
    // The task arrives without its relations, so the assignee is resolved
    // through the member map the panel already holds.
    const assignee =
      memberNames[String(task.assigneeId ?? '')] ?? readDisplayName(task.assignee);
    const classColor = getObjectColor('task');
    // A deal matters more than the contact it goes through, so it leads.
    const RANK: Record<string, number> = { opportunity: 0, company: 1 };
    const links = taskTargets
      .filter((link) => link.taskId === task.id)
      .map((link) => resolveTarget(link))
      .filter((link): link is ResolvedTarget => link !== null)
      .sort((a, b) => (RANK[a.objectNameSingular] ?? 2) - (RANK[b.objectNameSingular] ?? 2));

    const comments = taskEdits
      .filter((edit) => edit.targetTaskId === task.id)
      .map((edit) => ({ edit, parsed: readNoteEdit(edit) }))
      // An empty `before` means the body was written for the first time —
      // that is the task's own description, not a comment on it.
      .filter(({ parsed }) => parsed.text !== '' && parsed.before !== '');

    const cardKey = `task-card-${String(task.id)}`;
    const isCardHovered = hoveredCard === cardKey;

    return (
      <div
        key={String(task.id)}
        onMouseEnter={() => setHoveredCard(cardKey)}
        onMouseLeave={() => setHoveredCard(null)}
        style={{
          margin: '16px 12px',
          border: `1px solid ${
            isCardHovered ? palette.cardHoverBorder : palette.border
          }`,
          borderRadius: '10px',
          background: colorScheme === 'dark' ? '#1B1B1B' : '#FFFFFF',
          overflow: 'hidden',
          transition: 'border-color 140ms ease',
        }}
      >
      <div
        onClick={() =>
          openRecord({
            objectNameSingular: 'task',
            recordId: String(task.id),
            label: title,
          })
        }
        style={{
          display: 'flex',
          gap: '11px',
          padding: '12px 14px',
          cursor: 'pointer',
        }}
      >
        <div style={{ paddingTop: '1px' }}>
          <InlineAvatar
            size={15}
            label={title}
            color={`${classColor}22`}
            textColor={classColor}
          />
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: '10px',
            }}
          >
            <span
              style={{
                fontSize: '0.92rem',
                fontWeight: isOverdue ? 500 : 400,
                color: palette.text,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {title}
            </span>
            <span
              style={{
                fontSize: '0.92rem',
                fontWeight: 400,
                color: isOverdue ? '#D45453' : palette.textLight,
                whiteSpace: 'nowrap',
              }}
            >
              {due.label}
            </span>
          </div>

          <div
            style={{
              marginTop: '4px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: '0.92rem',
              fontWeight: 400,
              color: palette.textLight,
              flexWrap: 'nowrap',
              whiteSpace: 'nowrap',
            }}
          >
            {renderFieldValue('task', 'status', task.status, String(task.status))}
            {assignee !== '' && (
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {assignee}
              </span>
            )}
          </div>

          {/* Links get a line of their own: cramming them next to the status
              broke the assignee name across two lines. Overflow scrolls. */}
          {links.length > 0 && (
            <div
              style={{
                marginTop: '5px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                // Wrap rather than scroll: a scrollbar inside a card reads as
                // a defect, and links are few enough to fold onto a new line.
                flexWrap: 'wrap',
                rowGap: '5px',
              }}
            >
            {links.map((link) => {
              const linkColor = getObjectColor(link.objectNameSingular);

              return (
                <span
                  key={link.recordId}
                  onClick={(event) => {
                    event.stopPropagation();
                    openRecord(link);
                  }}
                  title={t("Open: {label}", { label: link.label })}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '5px',
                    maxWidth: '180px',
                    padding: '1px 7px 1px 3px',
                    borderRadius: '4px',
                    background: `${linkColor}14`,
                    cursor: 'pointer',
                    flexShrink: 0,
                    whiteSpace: 'nowrap',
                  }}
                >
                  <InlineAvatar
                    size={14}
                    label={link.label}
                    color={`${linkColor}2E`}
                    textColor={linkColor}
                    avatarUrl={link.avatarUrl}
                  />
                  <span
                    style={{
                      color: palette.textMid,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {link.label}
                  </span>
                </span>
              );
            })}
            </div>
          )}

        </div>
        </div>

          {comments.length > 0 && (
            <div
              style={{
                borderTop: `1px solid ${palette.border}`,
                background: colorScheme === 'dark' ? '#191919' : '#FAFAFA',
                padding: '4px 0',
              }}
            >
              {(() => {
                const key = `task-${String(task.id)}`;
                const thread = splitThread(comments, key);

                return thread.hidden > 0 ? (
                  <div style={{ padding: '4px 14px 0' }}>
                    {renderThreadToggle(thread.hidden, key)}
                  </div>
                ) : null;
              })()}

              {splitThread(comments, `task-${String(task.id)}`).visible.map(
                ({ edit, parsed }) =>
                  renderComment(
                    edit,
                    parsed,
                    () =>
                      openRecord({
                        objectNameSingular: 'task',
                        recordId: String(task.id),
                        label: title,
                      }),
                    t('Open task'),
                  ),
              )}
            </div>
          )}
      </div>
    );
  };

  // A comment looks the same wherever it appears — Buzz and tasks were drifting
  // apart because they were written at different times.
  const renderComment = (
    edit: TimelineRecord,
    parsed: ReturnType<typeof readNoteEdit>,
    onOpen: () => void,
    openLabel: string,
  ) => {
    // The event's own column first: it survives a depth-0 fetch, where the
    // `workspaceMember` relation does not. `updatedBy` is the last resort — it
    // names whatever actor last wrote the row, which for anything touched by a
    // script or an integration is the token, not a person.
    const commenterId =
      String(edit.workspaceMemberId ?? '') ||
      readMemberId(edit.workspaceMember) ||
      readMemberId(edit.updatedBy) ||
      '';
    const commenter =
      memberNames[commenterId] ||
      readDisplayName(edit.workspaceMember) ||
      readDisplayName(edit.updatedBy);
    const editId = String(edit.id);
    const avatarUrl = memberAvatars[commenterId];

    return (
      <div
        key={editId}
        onClick={() =>
          setExpandedComments((keys) =>
            keys.includes(editId)
              ? keys.filter((key) => key !== editId)
              : [...keys, editId],
          )
        }
        onMouseEnter={() => setHoveredId(editId)}
        onMouseLeave={() => setHoveredId(null)}
        title={t("Show what this was written against")}
        style={{
          display: 'flex',
          gap: '8px',
          padding: '8px 14px',
          alignItems: 'flex-start',
          cursor: 'pointer',
          background: hoveredId === editId ? palette.hover : 'transparent',
        }}
      >
        <InlineAvatar
          size={22}
          // An unresolved author is a person we cannot name, not a puzzle: a
          // bare "?" in a chip reads as a rendering fault.
          label={commenter !== '' ? commenter : t('Someone')}
          color={palette.mutedFill}
          textColor={palette.textMid}
          avatarUrl={avatarUrl}
        />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
            <span
              style={{
                fontSize: '0.92rem',
                fontWeight: 500,
                color: palette.text,
              }}
            >
              {commenter !== '' ? commenter : t('Someone')}
            </span>
            <span style={{ fontSize: '0.85rem', color: palette.textLight }}>
              {formatAgo(String(edit.happensAt))}
            </span>
            {parsed.isRewrite && (
              <span style={{ fontSize: '0.85rem', color: palette.textLight }}>
                {t('rewrote the text')}
              </span>
            )}
          </div>

          <div
            style={{
              marginTop: '2px',
              fontSize: '0.92rem',
              fontWeight: 400,
              color: palette.textMid,
              lineHeight: '1.55',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            {announce(parsed.text)}
          </div>

          {expandedComments.includes(editId) && (
            <div
              style={{
                marginTop: '8px',
                paddingLeft: '10px',
                borderLeft: `2px solid ${palette.border}`,
              }}
            >
              {readContextBefore(parsed.before).map((block, index) => (
                <div
                  key={index}
                  style={{
                    fontSize: '0.92rem',
                    fontWeight: 400,
                    color: palette.textLight,
                    lineHeight: '1.55',
                    whiteSpace: 'pre-wrap',
                    overflowWrap: 'anywhere',
                    marginBottom: '4px',
                  }}
                >
                  {block}
                </div>
              ))}

              <div
                style={{
                  marginTop: '2px',
                  padding: '4px 7px',
                  borderRadius: '4px',
                  background: `${getObjectColor('note')}1F`,
                  fontSize: '0.92rem',
                  fontWeight: 400,
                  color: palette.text,
                  lineHeight: '1.55',
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                }}
              >
                {announce(parsed.text)}
              </div>

              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpen();
                }}
                style={{
                  marginTop: '6px',
                  border: 'none',
                  background: 'transparent',
                  padding: 0,
                  fontFamily: 'inherit',
                  fontSize: '0.85rem',
                  color: palette.textMid,
                  cursor: 'pointer',
                  textDecoration: 'underline',
                }}
              >
                {openLabel}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderBuzzPost = (post: (typeof buzzPosts)[number]) => {
    const { note, comments, originalBody, touchedAt } = post;
    const title =
      typeof note.title === 'string' && note.title.trim() !== ''
        ? note.title
        : t('Untitled');
    const author = readDisplayName(note.createdBy);
    const noteColor = getObjectColor('note');

    const cardKey = `post-${String(note.id)}`;
    const isCardHovered = hoveredCard === cardKey;

    return (
      <div
        key={String(note.id)}
        onMouseEnter={() => setHoveredCard(cardKey)}
        onMouseLeave={() => setHoveredCard(null)}
        style={{
          margin: '16px 12px',
          border: `1px solid ${
            isCardHovered ? palette.cardHoverBorder : palette.border
          }`,
          borderRadius: '10px',
          background: colorScheme === 'dark' ? '#1B1B1B' : '#FFFFFF',
          overflow: 'hidden',
          transition: 'border-color 140ms ease',
        }}
      >
        <div
          onClick={() =>
            openRecord({
              objectNameSingular: 'note',
              recordId: String(note.id),
              label: title,
            })
          }
          style={{ padding: '12px 14px', cursor: 'pointer' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <InlineAvatar
              size={28}
              label={author !== '' ? author : title}
              color={`${noteColor}22`}
              textColor={noteColor}
              avatarUrl={memberAvatars[readMemberId(note.createdBy) ?? '']}
            />
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: '0.92rem',
                  fontWeight: 500,
                  color: palette.text,
                }}
              >
                {author !== '' ? author : t('Unknown author')}
              </div>
              <div style={{ fontSize: '0.85rem', color: palette.textLight }}>
                {formatAgo(touchedAt)}
              </div>
            </div>
          </div>

          <div
            style={{
              marginTop: '10px',
              fontSize: '0.92rem',
              fontWeight: 500,
              color: palette.text,
            }}
          >
            {title}
          </div>

          {originalBody !== '' && (
            <div
              style={{
                marginTop: '4px',
                fontSize: '0.92rem',
                fontWeight: 400,
                color: palette.textMid,
                lineHeight: '1.55',
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
              }}
            >
              {announce(originalBody)}
            </div>
          )}
        </div>

        {comments.length > 0 && (
          <div
            style={{
              borderTop: `1px solid ${palette.border}`,
              background: colorScheme === 'dark' ? '#191919' : '#FAFAFA',
              padding: '4px 0',
            }}
          >
            {(() => {
              const thread = splitThread(comments, `note-${String(note.id)}`);

              return thread.hidden > 0 ? (
                <div style={{ padding: '4px 14px 0' }}>
                  {renderThreadToggle(
                    thread.hidden,
                    `note-${String(note.id)}`,
                  )}
                </div>
              ) : null;
            })()}

            {splitThread(comments, `note-${String(note.id)}`).visible.map(
              ({ edit, parsed }) =>
                renderComment(
                  edit,
                  parsed,
                  () =>
                    openRecord({
                      objectNameSingular: 'note',
                      recordId: String(note.id),
                      label: title,
                    }),
                  t('Open note'),
                ),
            )}
          </div>
        )}
      </div>
    );
  };

  // A thread reads oldest-first, but when it grows the recent replies are the
  // ones that matter — so the older head is folded away.
  const VISIBLE_COMMENTS = 3;

  const splitThread = <T,>(comments: T[], key: string) => {
    if (comments.length <= VISIBLE_COMMENTS || expandedThreads.includes(key)) {
      return { hidden: 0, visible: comments };
    }

    return {
      hidden: comments.length - VISIBLE_COMMENTS,
      visible: comments.slice(-VISIBLE_COMMENTS),
    };
  };

  const renderThreadToggle = (hidden: number, key: string) => (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        setExpandedThreads((keys) =>
          keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key],
        );
      }}
      style={{
        border: 'none',
        background: 'transparent',
        padding: 0,
        marginTop: '6px',
        fontFamily: 'inherit',
        fontSize: '0.92rem',
        fontWeight: 400,
        color: palette.textMid,
        cursor: 'pointer',
        textDecoration: 'underline',
      }}
    >
      {hidden === 1
        ? t('1 more comment')
        : t('{hidden} more comments', { hidden })}
    </button>
  );

  const renderBulk = (
    entry: { key: string; items: TimelineRecord[] },
    unread: boolean,
  ) => {
    const [head] = entry.items;
    const described = describe(head);
    const author = described.author;
    const isExpanded = expandedKeys.includes(entry.key);
    const classColor = getObjectColor(described.objectNameSingular);
    const isActive = unread;
    // Twelve files uploaded to deals is "12 × document", not "12 × Deal": the
    // target object is what they hang on, not what appeared.
    const linkedMessage =
      described.linkedKind === null
        ? undefined
        : LINKED_KIND_LABELS[
            described.linkedKind as keyof typeof LINKED_KIND_LABELS
          ];
    const verbMessage =
      LINKED_ACTION_LABELS[
        getEventAction(head) as keyof typeof LINKED_ACTION_LABELS
      ];
    const bulkLabel =
      linkedMessage !== undefined ? t(linkedMessage) : described.objectLabel;
    // `actionLabel` already reads "document added" for linked events, which
    // would repeat the label above — the bare verb is enough there.
    const bulkAction =
      linkedMessage !== undefined && verbMessage !== undefined
        ? t(verbMessage)
        : described.actionLabel;

    const isRowHovered = hoveredCard === entry.key;

    return (
      <div
        key={entry.key}
        onMouseEnter={() => setHoveredCard(entry.key)}
        onMouseLeave={() => setHoveredCard(null)}
        style={{
          margin: '10px 12px',
          paddingBottom: '12px',
          border: `1px solid ${
            isRowHovered ? palette.cardHoverBorder : palette.border
          }`,
          borderRadius: '10px',
          background: unread
            ? isRowHovered
              ? palette.unreadHover
              : palette.unread
            : colorScheme === 'dark'
              ? '#1B1B1B'
              : '#FFFFFF',
          overflow: 'hidden',
          transition: 'background 140ms ease, border-color 140ms ease',
        }}
      >
        <div style={{ display: 'flex', gap: '11px', padding: '10px 16px 0' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: '10px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  minWidth: 0,
                }}
              >
                <InlineAvatar
                  size={15}
                  label={bulkLabel}
                  color={isActive ? `${classColor}22` : palette.mutedFill}
                  textColor={isActive ? classColor : palette.mutedGlyph}
                />
                <span
                  style={{
                    fontSize: '0.92rem',
                    fontWeight: unread ? 500 : 400,
                    color: palette.text,
                  }}
                >
                  {t('{count} × {object}', {
                    count: entry.items.length,
                    object: bulkLabel,
                  })}
                </span>
                <span
                  style={{
                    fontSize: '0.92rem',
                    fontWeight: 400,
                    color: palette.textLight,
                  }}
                >
                  {bulkAction}
                </span>
              </div>

              <span
                style={{
                  fontSize: '0.92rem',
                  fontWeight: 400,
                  color: palette.textLight,
                  whiteSpace: 'nowrap',
                }}
              >
                {formatAgo(String(head.happensAt))}
              </span>
            </div>

            <div
              style={{
                marginTop: '2px',
                fontSize: '0.92rem',
                fontWeight: 400,
                color: palette.textLight,
              }}
            >
              {t('bulk change')}
              {author !== '' ? ` · ${author}` : ''}
            </div>

            <button
              type="button"
              onClick={() =>
                setExpandedKeys((keys) =>
                  keys.includes(entry.key)
                    ? keys.filter((key) => key !== entry.key)
                    : [...keys, entry.key],
                )
              }
              style={{
                marginTop: '6px',
                border: 'none',
                background: 'transparent',
                padding: 0,
                fontFamily: 'inherit',
                fontSize: '0.92rem',
                fontWeight: 400,
                color: palette.textMid,
                cursor: 'pointer',
                textDecoration: 'underline',
              }}
            >
              {isExpanded ? t('Collapse') : t('Show records')}
            </button>

            {isExpanded &&
              entry.items.slice(0, 20).map((item) => {
                const target = resolveTarget(item);

                return (
                  <div
                    key={String(item.id)}
                    onClick={
                      target === null ? undefined : () => openRecord(target)
                    }
                    style={{
                      marginTop: '4px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '5px',
                      fontSize: '0.92rem',
                      fontWeight: 400,
                      color: target === null ? palette.textLight : palette.text,
                      cursor: target === null ? 'default' : 'pointer',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {typeof item.linkedRecordCachedName === 'string' &&
                    item.linkedRecordCachedName !== ''
                      ? // A linked note or task names itself; the click opens
                        // the record it hangs on.
                        `${item.linkedRecordCachedName}${
                          target !== null && target.label !== ''
                            ? ` · ${target.label}`
                            : ''
                        }`
                      : target !== null && target.label !== ''
                        ? target.label
                        : bulkLabel}
                  </div>
                );
              })}
          </div>
        </div>
      </div>
    );
  };

  const renderSectionHeader = (label: string, count?: number) => (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '16px 16px 6px',
      }}
    >
      <span
        style={{ fontSize: '0.85rem', fontWeight: 400, color: palette.textLight }}
      >
        {label}
        {count !== undefined ? ` · ${count}` : ''}
      </span>
      <div style={{ flex: 1, height: '1px', background: palette.border }} />
    </div>
  );

  return (
    <div
      onClick={markActive}
      onKeyDown={markActive}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        color: palette.text,
        fontFamily:
          'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          padding: '10px 16px',
          borderBottom: `1px solid ${palette.border}`,
          // A narrow panel must not stretch or wrap the controls — the strip
          // scrolls sideways instead.
          flexWrap: 'nowrap',
          overflowX: 'auto',
          scrollbarWidth: 'thin',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '7px',
            flexShrink: 0,
            whiteSpace: 'nowrap',
          }}
        >
          {/* Three tabs that never move. A breadcrumb here meant the strip was
              rebuilt on every switch and the whole row jumped sideways. */}
          <ToolbarButton
            label={t('Feed')}
            title={t('Everything that changed in the workspace.')}
            isActive={view === 'feed'}
            activeColor={ACCENT_BLUE}
            onClick={() => setView('feed')}
            background={palette.buttonBackground}
            color={palette.textMid}
          />
          <ToolbarButton
            label="Buzz"
            title={t('Team notes and the comments on them.')}
            isActive={view === 'buzz'}
            activeColor={ACCENT_BLUE}
            onClick={() => setView('buzz')}
            background={palette.buttonBackground}
            color={palette.textMid}
          />
          <ToolbarButton
            label={t('Tasks')}
            title={t('Open tasks: overdue first, then by due date.')}
            isActive={view === 'tasks'}
            activeColor={ACCENT_BLUE}
            onClick={() => setView('tasks')}
            background={palette.buttonBackground}
            color={palette.textMid}
          />
          {view === 'tasks' && overdueTasks.length > 0 && (
            <span
              title={t("Overdue: {count}", { count: overdueTasks.length })}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: '19px',
                height: '19px',
                padding: '0 5px',
                borderRadius: '10px',
                border: '1px solid #D45453',
                fontSize: '0.85rem',
                fontWeight: 400,
                color: '#D45453',
              }}
            >
              {overdueTasks.length}
            </span>
          )}
          {view === 'tasks' &&
            assignedOpenCount !== null &&
            assignedOpenCount > 0 && (
              <span
                title={t('Assigned to you and not done: {count}', {
                  count: assignedOpenCount,
                })}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: '19px',
                  height: '19px',
                  padding: '0 5px',
                  borderRadius: '10px',
                  border: `1px solid ${ACCENT_BLUE}`,
                  fontSize: '0.85rem',
                  fontWeight: 400,
                  color: ACCENT_BLUE,
                }}
              >
                {assignedOpenCount}
              </span>
            )}
          {view === 'feed' && unreadCount > 0 && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: '19px',
                height: '19px',
                padding: '0 5px',
                borderRadius: '10px',
                border: `1px solid ${palette.rail}`,
                fontSize: '0.85rem',
                fontWeight: 400,
                color: palette.textMid,
              }}
            >
              {unreadCount}
            </span>
          )}
          {view === 'feed' && unreadCount > 0 && (
            <ToolbarButton
              label={t("Mark all read")}
              title={t("Mark every event as read")}
              onClick={() => void markAllAsRead()}
              background={palette.buttonBackground}
              color={palette.textMid}
            />
          )}
        </div>
      </div>

      <div
        onScroll={markActive}
        style={{ flex: 1, overflowY: 'auto', paddingBottom: '12px' }}
      >
        {/* Not an error page: the panel keeps working on what it did get. But
            a background load that fails in silence looks exactly like a
            workspace where nothing happened, and that is how the worst of this
            app's bugs stayed hidden. */}
        {degraded.length > 0 && (
          <div
            title={degraded.join(', ')}
            style={{
              padding: '8px 16px',
              fontSize: '0.85rem',
              color: '#D45453',
              borderBottom: `1px solid ${palette.border}`,
            }}
          >
            {t('Some of this could not be loaded — you are seeing less than there is.')}
          </div>
        )}

        {isPaused && (
          <div
            style={{
              padding: '8px 16px',
              fontSize: '0.85rem',
              color: palette.textLight,
              borderBottom: `1px solid ${palette.border}`,
            }}
          >
            {t('Updates are paused while the panel is idle. Click to resume.')}
          </div>
        )}

        {isLoading && (
          <div style={{ padding: '16px', fontSize: '0.92rem', color: palette.textLight }}>
            {t('Loading…')}
          </div>
        )}

        {error !== null && (
          <div style={{ padding: '16px', fontSize: '0.92rem', color: '#D45453' }}>
            {t('Could not load the feed: {error}', { error })}
          </div>
        )}

        {view === 'feed' && !isLoading && error === null && items.length === 0 && (
          <div style={{ padding: '16px', fontSize: '0.92rem', color: palette.textLight }}>
            {t('Nothing has happened yet. Create or change any record and the event shows up here.')}
          </div>
        )}

        {view === 'feed' && (
          <>
            {unreadEntries.length > 0 &&
              renderSectionHeader(t('New'), unreadEntries.length)}
            {unreadEntries.map((entry) =>
              entry.kind === 'bulk'
                ? renderBulk(entry, true)
                : renderGroup(entry, true),
            )}

            {readEntries.length > 0 &&
              unreadEntries.length > 0 &&
              renderSectionHeader(t('Earlier'), readEntries.length)}
            {readEntries.map((entry) =>
              entry.kind === 'bulk'
                ? renderBulk(entry, false)
                : renderGroup(entry, false),
            )}

            {!isLoading && changes.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  padding: '14px 16px 4px',
                }}
              >
                {!isFeedExhausted &&
                  loadedEvents.length < FEED_LIMIT &&
                  loadedEvents.length < feedTotal && (
                  <ToolbarButton
                    label={isLoadingMore ? t('Loading…') : t('Show more')}
                    title={t('Load the previous page of events')}
                    onClick={() => void loadMore()}
                    background={palette.buttonBackground}
                    color={palette.textMid}
                  />
                )}
                {/* Everything here is personal, so the count is personal
                    too: the updates on your records this week. A workspace-wide
                    denominator would be a number this feed never reaches. What
                    was scanned to find them lives in the tooltip. */}
                <span
                  title={t(
                    'Scanned {loaded} of {total} workspace updates from the last {days} days',
                    {
                      loaded: loadedEvents.length,
                      total: feedTotal,
                      days: FEED_WINDOW_DAYS,
                    },
                  )}
                  style={{ fontSize: '0.85rem', color: palette.textLight }}
                >
                  {t('{count} updates on your records this week', {
                    count: visibleEventCount,
                  })}
                </span>
              </div>
            )}


          </>
        )}

        {view === 'buzz' && (
          <>
            {buzzPosts.map(renderBuzzPost)}
            {buzzPosts.length === 0 && (
              <div
                style={{
                  padding: '16px',
                  fontSize: '0.92rem',
                  color: palette.textLight,
                }}
              >
                {t('No notes yet.')}
              </div>
            )}
          </>
        )}

        {view === 'tasks' && (
          <>
            {overdueTasks.length > 0 &&
              renderSectionHeader(t('Overdue'), overdueTasks.length)}
            {overdueTasks.map(renderTask)}

            {upcomingTasks.length > 0 &&
              renderSectionHeader(
                overdueTasks.length > 0 ? t('By due date') : t('Upcoming'),
                upcomingTasks.length,
              )}
            {upcomingTasks.map(renderTask)}

            {openTasks.length === 0 && (
              <div
                style={{
                  padding: '16px',
                  fontSize: '0.92rem',
                  color: palette.textLight,
                }}
              >
                {t('No open tasks.')}
              </div>
            )}

            {/* The list is a page of a longer list, and used to end without
                saying so: the badge said forty-nine and the tab showed
                twenty-five. Either there is more to load, or the count says
                how much is left over. */}
            {openTasks.length > 0 && myTaskTotal > openTasks.length && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  padding: '14px 16px 4px',
                }}
              >
                {taskLimit < TASK_LIMIT && (
                  <ToolbarButton
                    label={t('Show more')}
                    title={t('Load more of your open tasks')}
                    onClick={() =>
                      setTaskLimit((limit) =>
                        Math.min(limit + TAB_PAGE_SIZE, TASK_LIMIT),
                      )
                    }
                    background={palette.buttonBackground}
                    color={palette.textMid}
                  />
                )}
                <span
                  style={{ fontSize: '0.85rem', color: palette.textLight }}
                >
                  {t('{shown} of {total}', {
                    shown: openTasks.length,
                    total: myTaskTotal,
                  })}
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default defineFrontComponent({
  universalIdentifier: ACTIVITY_FEED_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  name: 'activity-feed',
  description: 'Workspace activity feed built on the standard timelineActivity',
  component: ActivityFeed,
});
