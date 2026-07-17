const META_COLLECTIONS = [
  "subscriptions",
  "vehicles",
  "carExpenses",
  "healthAppointments",
  "medications",
  "healthMeasurements",
  "pets",
  "petExpenses",
  "petVisits",
];

const CHILD_RELATIONS = {
  carExpenses: ["vehicleId", "vehicles"],
  vehicleDeadlines: ["vehicleId", "vehicles"],
  petExpenses: ["petId", "pets"],
  petVisits: ["petId", "pets"],
};

const PERSONAL_LIFE_KEYS = ["scratchpad", "intention", "energy", "preferences"];
const LIFE_COLLECTIONS = ["tasks", "events", "reminders", "notes", "habits"];
const ADVANCED_COLLECTIONS = [
  "subscriptions",
  "vehicles",
  "carExpenses",
  "vehicleDeadlines",
  "healthAppointments",
  "medications",
  "healthMeasurements",
  "householdMembers",
  "pets",
  "petExpenses",
  "petVisits",
];

const asObject = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const asArray = (value) => (Array.isArray(value) ? value : []);

export function workspaceDocumentIsValid(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 2)
    return false;
  const life = asObject(value.life);
  const advanced = asObject(value.advanced);
  if (!Object.keys(life).length || !Object.keys(advanced).length) return false;
  for (const key of LIFE_COLLECTIONS) {
    if (!Array.isArray(life[key]) || life[key].length > 100_000) return false;
  }
  for (const key of ADVANCED_COLLECTIONS) {
    if (!Array.isArray(advanced[key])) return false;
    if (advanced[key].length > 100_000) return false;
    if (
      advanced[key].some(
        (item) =>
          !item ||
          typeof item !== "object" ||
          typeof item.id !== "string" ||
          item.id.length < 1 ||
          item.id.length > 200,
      )
    )
      return false;
  }
  return typeof life.preferences === "object" && typeof advanced.householdName === "string";
}

function withOwner(item, userId, isPrivate) {
  if (!item || typeof item !== "object") return item;
  const next = { ...item };
  if ("ownerId" in next) {
    if (isPrivate || next.ownerId === "me") next.ownerId = userId;
    if (isPrivate) next.visibility = "private";
  }
  return next;
}

export function splitWorkspaceData(input, userId) {
  const data = structuredClone(asObject(input));
  const advanced = asObject(data.advanced);
  const sharedAdvanced = { ...advanced };
  const privateAdvanced = {};
  const privateIds = new Map();

  for (const key of META_COLLECTIONS) {
    const records = asArray(advanced[key]);
    const privateRecords = records.filter((item) => item?.visibility === "private");
    privateIds.set(key, new Set(privateRecords.map((item) => item?.id).filter(Boolean)));
  }

  for (const [key, [foreignKey, parentKey]] of Object.entries(CHILD_RELATIONS)) {
    const parentIds = privateIds.get(parentKey) ?? new Set();
    const records = asArray(advanced[key]);
    const ownPrivate = records.filter((item) => item?.visibility === "private");
    const relatedPrivate = records.filter(
      (item) => item?.[foreignKey] && parentIds.has(item[foreignKey]),
    );
    privateIds.set(
      key,
      new Set([...ownPrivate, ...relatedPrivate].map((item) => item?.id).filter(Boolean)),
    );
  }

  const collectionKeys = new Set([
    ...Object.keys(advanced).filter((key) => Array.isArray(advanced[key])),
    ...META_COLLECTIONS,
    ...Object.keys(CHILD_RELATIONS),
  ]);
  for (const key of collectionKeys) {
    const records = asArray(advanced[key]);
    const ids = privateIds.get(key) ?? new Set();
    privateAdvanced[key] = records
      .filter((item) => item?.id && ids.has(item.id))
      .map((item) => withOwner(item, userId, true));
    sharedAdvanced[key] = records
      .filter((item) => !item?.id || !ids.has(item.id))
      .map((item) => withOwner(item, userId, false));
  }

  privateAdvanced.hideAmounts = Boolean(advanced.hideAmounts);
  delete sharedAdvanced.householdMembers;
  delete sharedAdvanced.householdName;
  delete sharedAdvanced.hideAmounts;

  const life = asObject(data.life);
  const sharedLife = { ...life };
  const privateLife = {};
  for (const key of PERSONAL_LIFE_KEYS) {
    if (key in life) {
      privateLife[key] =
        key === "preferences"
          ? Object.fromEntries(
              Object.entries(asObject(life[key])).filter(
                ([preference]) => preference !== "notificationsEnabled",
              ),
            )
          : life[key];
    }
    delete sharedLife[key];
  }

  for (const key of LIFE_COLLECTIONS) {
    const records = asArray(life[key]);
    privateLife[key] = records
      .filter((item) => item?.visibility === "private")
      .map((item) => withOwner(item, userId, true));
    sharedLife[key] = records
      .filter((item) => item?.visibility !== "private")
      .map((item) => withOwner(item, userId, false));
  }

  return {
    sharedData: { ...data, life: sharedLife, advanced: sharedAdvanced },
    privateData: { life: privateLife, advanced: privateAdvanced },
  };
}

function mergeById(sharedRecords, privateRecords) {
  const result = [];
  const positions = new Map();
  for (const item of [...asArray(sharedRecords), ...asArray(privateRecords)]) {
    if (item?.id && positions.has(item.id)) {
      result[positions.get(item.id)] = item;
    } else {
      if (item?.id) positions.set(item.id, result.length);
      result.push(item);
    }
  }
  return result;
}

function memberColor(id) {
  const colors = ["#397763", "#5677a8", "#a66f45", "#8065a8", "#a85f6a", "#4d858b"];
  let hash = 0;
  for (const char of String(id)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length];
}

export function mergeWorkspaceData(sharedInput, privateInput, context) {
  const shared = structuredClone(asObject(sharedInput));
  const personal = structuredClone(asObject(privateInput));
  const sharedAdvanced = asObject(shared.advanced);
  const privateAdvanced = asObject(personal.advanced);
  const hasAdvancedState =
    Object.keys(sharedAdvanced).length > 0 || Object.keys(privateAdvanced).length > 0;
  const sharedLife = asObject(shared.life);
  const privateLife = asObject(personal.life);
  const privatePreferences = asObject(privateLife.preferences);
  const hasLifeState = Object.keys(sharedLife).length > 0 || Object.keys(privateLife).length > 0;
  const advanced = { ...sharedAdvanced };
  const collectionKeys = new Set([
    ...Object.keys(sharedAdvanced).filter((key) => Array.isArray(sharedAdvanced[key])),
    ...Object.keys(privateAdvanced).filter((key) => Array.isArray(privateAdvanced[key])),
    ...META_COLLECTIONS,
    ...Object.keys(CHILD_RELATIONS),
  ]);
  for (const key of collectionKeys) {
    advanced[key] = mergeById(sharedAdvanced[key], privateAdvanced[key]).map((item) =>
      item?.visibility === "private" ? withOwner(item, context.userId, true) : item,
    );
  }
  advanced.hideAmounts = Boolean(privateAdvanced.hideAmounts);
  advanced.householdName = context.householdName;
  advanced.householdMembers = context.members.map((member) => ({
    id: member.id,
    name: member.name,
    email: member.email,
    role: member.role,
    color: memberColor(member.id),
  }));

  const lifeCollections = {};
  for (const key of LIFE_COLLECTIONS) {
    lifeCollections[key] = mergeById(sharedLife[key], privateLife[key]).map((item) =>
      item?.visibility === "private" ? withOwner(item, context.userId, true) : item,
    );
  }

  const life = {
    ...sharedLife,
    ...lifeCollections,
    scratchpad: privateLife.scratchpad ?? "",
    intention: privateLife.intention ?? "",
    energy: privateLife.energy ?? "medium",
    preferences: {
      theme: "system",
      notificationsEnabled: false,
      weekStartsOnMonday: true,
      ...privatePreferences,
      name: String(privatePreferences.name ?? "").trim() || context.userName || "",
    },
  };

  const result = { ...shared };
  if (hasLifeState) result.life = life;
  else delete result.life;
  if (hasAdvancedState) result.advanced = advanced;
  else delete result.advanced;
  return result;
}
