import type { Database } from '@space/database';
import { UniqueConstraintError } from '@space/database';

/**
 * An in-memory stand-in for the Prisma/Database surface the notification
 * pipeline uses.
 *
 * No local Postgres exists in this repository's development loop, so the sweep,
 * outbox consumer, reminder dispatcher and delivery service are exercised
 * against this fake and cast to the real `Database` type at the boundary. It
 * reproduces the two properties the code depends on:
 *
 *  - `$transaction` is write-ahead: the work runs against a clone of the store
 *    and is committed only when the callback resolves, so a failure rolls the
 *    whole unit of work back.
 *  - `updateMany` returns a `count`, which is what every compare-and-swap claim
 *    (reminder, notification dispatch) keys on.
 *
 * Query support is deliberately just what these modules use: equality, `in`,
 * `not`, `increment`, range operators, `OR`, ordering and one level of include.
 * It extends the planning package's harness (same semantics) with the
 * notification tables: `notification`, `emailLog`, `outboxCursor`.
 */

export type FakeRow = Record<string, unknown>;

interface WhereClause {
  [field: string]: unknown;
}

interface OrderByRule {
  field: string;
  direction: 'asc' | 'desc';
  nullsLast: boolean;
}

interface FindManyOptions {
  where?: WhereClause;
  orderBy?: unknown;
  take?: number;
  include?: Record<string, boolean>;
}

const OPERATOR_KEYS = ['in', 'gte', 'gt', 'lte', 'lt', 'not', 'equals'] as const;

export class FakeStore {
  readonly rows = new Map<string, Map<string, FakeRow>>();
  private idCounter = 0;
  private sequenceCounter = 0;

  collection(model: string): Map<string, FakeRow> {
    let table = this.rows.get(model);
    if (!table) {
      table = new Map<string, FakeRow>();
      this.rows.set(model, table);
    }
    return table;
  }

  all(model: string): FakeRow[] {
    return [...this.collection(model).values()];
  }

  insert(model: string, row: FakeRow): FakeRow {
    const table = this.collection(model);
    // Prisma auto-generates ids (cuid) for rows that omit them.
    const id = (row.id as string | undefined) ?? `fake-row-${++this.idCounter}`;
    // Seeding with explicit eventLog sequences must not collide with the
    // autoincrement: bump the counter past any number that was seeded.
    if (model === 'eventLog' && typeof row.sequence !== 'undefined') {
      const parsed = Number(row.sequence);
      if (Number.isInteger(parsed) && parsed > this.sequenceCounter) {
        this.sequenceCounter = parsed;
      }
    }
    const stored = { ...row, id };
    table.set(id, stored);
    return stored;
  }

  nextSequence(): string {
    this.sequenceCounter += 1;
    return String(this.sequenceCounter);
  }

  clone(): FakeStore {
    const copy = new FakeStore();
    copy.idCounter = this.idCounter;
    copy.sequenceCounter = this.sequenceCounter;
    for (const [model, table] of this.rows) {
      const cloned = new Map<string, FakeRow>();
      for (const [id, row] of table) {
        cloned.set(id, structuredClone(row));
      }
      copy.rows.set(model, cloned);
    }
    return copy;
  }

  replace(other: FakeStore): void {
    this.rows.clear();
    for (const [model, table] of other.rows) {
      this.rows.set(model, new Map(table));
    }
    // A committed transaction must advance the shared counters, or the next
    // transaction regenerates the same auto ids/sequences and silently
    // overwrites committed rows.
    this.idCounter = Math.max(this.idCounter, other.idCounter);
    this.sequenceCounter = Math.max(this.sequenceCounter, other.sequenceCounter);
  }
}

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? (value as unknown[]) : []);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !(value instanceof Date);

const isOperatorObject = (value: unknown): value is Record<string, unknown> => {
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    return false;
  }
  return Object.keys(value).every((key) => (OPERATOR_KEYS as readonly string[]).includes(key));
};

const sameValue = (a: unknown, b: unknown): boolean => {
  if (a instanceof Date || b instanceof Date) {
    const left = a instanceof Date ? a.getTime() : new Date(String(a)).getTime();
    const right = b instanceof Date ? b.getTime() : new Date(String(b)).getTime();
    return Number.isFinite(left) && Number.isFinite(right) && left === right;
  }
  return a === b;
};

const operatorMatch = (actual: unknown, operator: Record<string, unknown>): boolean => {
  if ('in' in operator) {
    return asArray(operator.in).some((candidate) => sameValue(actual, candidate));
  }
  if ('not' in operator) {
    return !sameValue(actual, operator.not);
  }
  if ('equals' in operator) {
    return sameValue(actual, operator.equals);
  }

  const toMillis = (value: unknown): number =>
    value instanceof Date ? value.getTime() : Number(String(value));

  for (const key of ['gte', 'gt', 'lte', 'lt'] as const) {
    if (key in operator) {
      const limit = toMillis(operator[key]);
      const value = toMillis(actual);
      if (key === 'gte' && value < limit) {
        return false;
      }
      if (key === 'gt' && value <= limit) {
        return false;
      }
      if (key === 'lte' && value > limit) {
        return false;
      }
      if (key === 'lt' && value >= limit) {
        return false;
      }
    }
  }
  return true;
};

const matchesWhere = (row: FakeRow, where: WhereClause): boolean => {
  for (const [field, condition] of Object.entries(where)) {
    if (field === 'OR') {
      if (!asArray(condition).some((clause) => matchesWhere(row, clause as WhereClause))) {
        return false;
      }
      continue;
    }

    if (isOperatorObject(condition)) {
      if (!operatorMatch(row[field], condition)) {
        return false;
      }
      continue;
    }

    if (isPlainObject(condition)) {
      if (!matchesWhere(row, condition)) {
        return false;
      }
      continue;
    }

    if (!sameValue(row[field], condition)) {
      return false;
    }
  }
  return true;
};

const applyData = (row: FakeRow, data: Record<string, unknown>): void => {
  for (const [key, value] of Object.entries(data)) {
    if (isPlainObject(value) && 'increment' in value && typeof value.increment === 'number') {
      row[key] = (typeof row[key] === 'number' ? row[key] : 0) + value.increment;
      continue;
    }
    row[key] = value;
  }
};

const withDefaults = (model: string, row: FakeRow): FakeRow => {
  if (model === 'space' && row.planVersion === undefined) {
    return { ...row, planVersion: 0 };
  }
  // Mirror the schema default: repos create notifications without a state.
  if (model === 'notification' && row.deliveryState === undefined) {
    return { ...row, deliveryState: 'PENDING' };
  }
  return { ...row };
};

const comparePrimitives = (a: unknown, b: unknown): number => {
  const toComparable = (value: unknown): string =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '';
  return toComparable(a).localeCompare(toComparable(b));
};

const compareRows = (a: FakeRow, b: FakeRow, rules: OrderByRule[]): number => {
  for (const rule of rules) {
    const left = a[rule.field];
    const right = b[rule.field];

    if (left === null || left === undefined || right === null || right === undefined) {
      if (left == null && right != null) {
        return rule.nullsLast ? 1 : -1;
      }
      if (left != null && right == null) {
        return rule.nullsLast ? -1 : 1;
      }
      continue;
    }

    if (left instanceof Date && right instanceof Date) {
      const delta = left.getTime() - right.getTime();
      return rule.direction === 'asc' ? delta : -delta;
    }

    const delta = comparePrimitives(left, right);
    if (delta !== 0) {
      return rule.direction === 'asc' ? delta : -delta;
    }
  }
  return 0;
};

const parseOrderBy = (value: unknown): OrderByRule[] => {
  const entries = Array.isArray(value) ? value : [value];

  const rules: OrderByRule[] = [];
  for (const entry of entries) {
    if (!isPlainObject(entry)) {
      continue;
    }
    for (const [field, spec] of Object.entries(entry)) {
      if (isPlainObject(spec)) {
        rules.push({
          field,
          direction: spec.direction === 'desc' ? 'desc' : 'asc',
          nullsLast: spec.nulls === 'last',
        });
        continue;
      }
      rules.push({
        field,
        direction: spec === 'desc' ? 'desc' : 'asc',
        nullsLast: false,
      });
    }
  }
  return rules;
};

export interface FakeWriteHook {
  /** Called before every write; throw to force a transactional failure. */
  onWrite?: (model: string, method: string) => void;
}

export class FakeTable {
  constructor(
    private readonly model: string,
    private readonly store: FakeStore,
    private readonly writeHook?: FakeWriteHook['onWrite'],
  ) {}

  create(options: { data: Record<string, unknown> }): FakeRow {
    this.guard('create');
    const full = withDefaults(this.model, options.data);
    if (this.model === 'eventLog' && full.sequence === undefined) {
      full.sequence = this.store.nextSequence();
    }
    // Mirror the physical `deliveryKey` unique index — the whole idempotency
    // story of the pipeline rests on it, so the tests must observe the same
    // constraint violation a real Postgres would raise.
    if (this.model === 'notification' && typeof full.deliveryKey === 'string') {
      const clash = this.store
        .all('notification')
        .some((row) => row.deliveryKey === full.deliveryKey);
      if (clash) {
        throw new UniqueConstraintError(['deliveryKey']);
      }
    }
    return this.store.insert(this.model, full);
  }

  findMany(options: FindManyOptions = {}): FakeRow[] {
    const where = options.where ?? {};
    const rows = this.store.all(this.model).filter((row) => matchesWhere(row, where));

    const order = parseOrderBy(options.orderBy);
    if (order.length > 0) {
      rows.sort((a, b) => compareRows(a, b, order));
    }

    if (options.take !== undefined) {
      rows.splice(options.take);
    }

    if (options.include) {
      for (const row of rows) {
        this.attachIncludes(row, options.include);
      }
    }

    return rows;
  }

  findUnique(options: { where: WhereClause; include?: Record<string, boolean> }): FakeRow | null {
    const row =
      this.store.all(this.model).find((candidate) => matchesWhere(candidate, options.where)) ??
      null;
    if (row !== null && options.include) {
      this.attachIncludes(row, options.include);
    }
    return row;
  }

  findFirst(options: FindManyOptions = {}): FakeRow | null {
    const rows = this.findMany(options);
    return rows[0] ?? null;
  }

  count(options: FindManyOptions = {}): number {
    return this.findMany(options).length;
  }

  updateMany(options: { where: WhereClause; data: Record<string, unknown> }): { count: number } {
    this.guard('updateMany');
    let count = 0;
    for (const row of this.store.collection(this.model).values()) {
      if (matchesWhere(row, options.where)) {
        applyData(row, options.data);
        count += 1;
      }
    }
    return { count };
  }

  upsert(options: {
    where: WhereClause;
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }): FakeRow {
    this.guard('upsert');
    const existing = this.store.all(this.model).find((row) => matchesWhere(row, options.where));
    if (existing) {
      applyData(existing, options.update);
      return existing;
    }
    return this.store.insert(this.model, withDefaults(this.model, options.create));
  }

  private guard(method: string): void {
    if (this.writeHook) {
      this.writeHook(this.model, method);
    }
  }

  private attachIncludes(row: FakeRow, include: Record<string, boolean>): void {
    const lookup = (relation: string, id: unknown): void => {
      if (typeof id === 'string' && this.store.collection(relation).has(id)) {
        row[relation] = this.store.collection(relation).get(id) ?? null;
      } else {
        row[relation] = null;
      }
    };

    if (include.task) {
      lookup('task', row.taskId);
    }
    if (include.reminder) {
      lookup('reminder', row.reminderId);
    }
    if (include.calendarEvent) {
      lookup('calendarEvent', row.calendarEventId);
    }
  }
}

export class FakeClient {
  readonly user: FakeTable;
  readonly userPreferences: FakeTable;
  readonly planningPreferences: FakeTable;
  readonly workingHoursBlock: FakeTable;
  readonly space: FakeTable;
  readonly spaceItem: FakeTable;
  readonly task: FakeTable;
  readonly taskDependency: FakeTable;
  readonly calendarEvent: FakeTable;
  readonly reminder: FakeTable;
  readonly eventLog: FakeTable;
  readonly agentAction: FakeTable;
  readonly notification: FakeTable;
  readonly emailLog: FakeTable;
  readonly outboxCursor: FakeTable;

  readonly $transaction: <T>(callback: (tx: FakeClient) => Promise<T> | T) => Promise<T>;

  #store: FakeStore;
  #writeHook: FakeWriteHook['onWrite'];

  constructor(store: FakeStore, writeHook?: FakeWriteHook['onWrite']) {
    this.#store = store;
    this.#writeHook = writeHook;

    this.user = new FakeTable('user', store, writeHook);
    this.userPreferences = new FakeTable('userPreferences', store, writeHook);
    this.planningPreferences = new FakeTable('planningPreferences', store, writeHook);
    this.workingHoursBlock = new FakeTable('workingHoursBlock', store, writeHook);
    this.space = new FakeTable('space', store, writeHook);
    this.spaceItem = new FakeTable('spaceItem', store, writeHook);
    this.task = new FakeTable('task', store, writeHook);
    this.taskDependency = new FakeTable('taskDependency', store, writeHook);
    this.calendarEvent = new FakeTable('calendarEvent', store, writeHook);
    this.reminder = new FakeTable('reminder', store, writeHook);
    this.eventLog = new FakeTable('eventLog', store, writeHook);
    this.agentAction = new FakeTable('agentAction', store, writeHook);
    this.notification = new FakeTable('notification', store, writeHook);
    this.emailLog = new FakeTable('emailLog', store, writeHook);
    this.outboxCursor = new FakeTable('outboxCursor', store, writeHook);

    this.$transaction = async <T>(callback: (tx: FakeClient) => Promise<T> | T): Promise<T> => {
      const tx = new FakeClient(this.#store.clone(), this.#writeHook);
      const result = await callback(tx);
      this.#store.replace(tx.#store);
      return result;
    };
  }
}

export type ModelName =
  | 'user'
  | 'userPreferences'
  | 'planningPreferences'
  | 'workingHoursBlock'
  | 'space'
  | 'spaceItem'
  | 'task'
  | 'taskDependency'
  | 'calendarEvent'
  | 'reminder'
  | 'eventLog'
  | 'agentAction'
  | 'notification'
  | 'emailLog'
  | 'outboxCursor';

export interface FakeDatabaseHandle {
  /** The client, cast to the app's `Database` surface. */
  db: Database;
  client: FakeClient;
  /** Inserts a raw row directly (test seeding). */
  insert(model: ModelName, row: FakeRow): FakeRow;
  /** Read access for assertions. */
  rows(model: ModelName): FakeRow[];
}

export const createFakeDatabase = (writeHook?: FakeWriteHook['onWrite']): FakeDatabaseHandle => {
  const store = new FakeStore();
  const client = new FakeClient(store, writeHook);

  return {
    db: client as unknown as Database,
    client,
    insert: (model, row) => store.insert(model, row),
    rows: (model) => store.all(model),
  };
};
