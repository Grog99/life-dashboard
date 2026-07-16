type JsonRecord = Record<string, unknown>;

const isObject = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

function isEntityArray(value: unknown): value is Array<JsonRecord & { id: string }> {
  return (
    Array.isArray(value) && value.every((item) => isObject(item) && typeof item.id === "string")
  );
}

function timestampOf(value: unknown): number | undefined {
  if (!isObject(value)) return undefined;
  const raw = value.updatedAt;
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const time = new Date(raw).getTime();
  return Number.isNaN(time) ? undefined : time;
}

interface MergeContext {
  localUpdatedAt?: number;
  remoteUpdatedAt?: number;
}

export function mergeWorkspaceChanges(
  base: unknown,
  local: unknown,
  remote: unknown,
  context: MergeContext = {},
): unknown {
  if (equal(local, base)) return clone(remote);
  if (equal(remote, base) || equal(local, remote)) return clone(local);

  const arrays = [base, local, remote];
  if (arrays.every((value) => value === undefined || isEntityArray(value))) {
    const baseMap = new Map(
      (base as Array<JsonRecord & { id: string }> | undefined)?.map((item) => [item.id, item]),
    );
    const localMap = new Map(
      (local as Array<JsonRecord & { id: string }> | undefined)?.map((item) => [item.id, item]),
    );
    const remoteMap = new Map(
      (remote as Array<JsonRecord & { id: string }> | undefined)?.map((item) => [item.id, item]),
    );
    const order = [
      ...((remote as Array<JsonRecord & { id: string }> | undefined) ?? []).map((item) => item.id),
      ...((local as Array<JsonRecord & { id: string }> | undefined) ?? []).map((item) => item.id),
    ];
    const ids = [...new Set(order)];
    return ids
      .map((id) => mergeWorkspaceChanges(baseMap.get(id), localMap.get(id), remoteMap.get(id)))
      .filter((item) => item !== undefined);
  }

  // One side deleted this record (base had it, the other side still does, and
  // the two disagree with each other) - without a recorded delete timestamp
  // this is treated as a tombstone that always wins, instead of arbitrarily
  // favoring whichever snapshot happens to be passed in as "local".
  if (local === undefined || remote === undefined) return undefined;

  if (isObject(local) && isObject(remote)) {
    const baseObject = isObject(base) ? base : {};
    const keys = new Set([
      ...Object.keys(baseObject),
      ...Object.keys(remote),
      ...Object.keys(local),
    ]);
    const nextContext: MergeContext = {
      localUpdatedAt: timestampOf(local) ?? context.localUpdatedAt,
      remoteUpdatedAt: timestampOf(remote) ?? context.remoteUpdatedAt,
    };
    return Object.fromEntries(
      [...keys]
        .map(
          (key) =>
            [
              key,
              mergeWorkspaceChanges(baseObject[key], local[key], remote[key], nextContext),
            ] as const,
        )
        .filter(([, value]) => value !== undefined),
    );
  }

  const { localUpdatedAt, remoteUpdatedAt } = context;
  if (
    localUpdatedAt !== undefined &&
    remoteUpdatedAt !== undefined &&
    remoteUpdatedAt !== localUpdatedAt
  ) {
    return clone(remoteUpdatedAt > localUpdatedAt ? remote : local);
  }

  return clone(local);
}
