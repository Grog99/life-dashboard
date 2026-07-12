export const meta = {
  name: 'implement-layered',
  description: 'Implementuje feature z planu warstwami: dane -> backend -> frontend, z handoffem schematu miedzy warstwami i petla weryfikacji build+testy',
  whenToUse: 'Gdy plan (docs/plans/<slug>.md) jest zaakceptowany i chcesz zaimplementowac feature warstwowo z deterministycznym porzadkiem i strukturyzowanym przekazaniem kontekstu miedzy warstwami.',
  phases: [
    { title: 'Warstwa danych', detail: 'migracje SQL w server/migrations, zapytania w server/src/db.mjs, wspoldzielone typy w src/types.ts', model: 'sonnet' },
    { title: 'Warstwa backend', detail: 'route handlery Fastify w server/src/server.mjs, worker Web Push w server/src/worker.mjs, middleware/autoryzacja', model: 'sonnet' },
    { title: 'Warstwa frontend', detail: 'komponenty i strony konsumujace backend (PWA, waski ekran)', model: 'sonnet' },
    { title: 'Weryfikacja', detail: 'npm run build + npm test + npm run test:server, ograniczona petla napraw', model: 'sonnet' },
  ],
}

// --- Wejscie ze skilla: { planPath, layers } ---
// planPath: sciezka do docs/plans/<slug>.md
// layers:   podzbior ['dane','backend','frontend'] w kolejnosci; puste => wszystkie trzy
//
// UWAGA: parametr `args` toola Workflow bywa dostarczany do skryptu jako JSON-string,
// a nie jako gotowy obiekt (zaobserwowane: `typeof args === 'string'`). Bez normalizacji
// `args.planPath` jest wtedy undefined i workflow padal natychmiast z 0 agentow.
// Dlatego: jesli args jest stringiem, probujemy go sparsowac, i dopiero potem czytamy pola.
let input = args
if (typeof input === 'string') {
  try { input = JSON.parse(input) } catch { /* zostaw jako string — obsluzy walidacja nizej */ }
}
const planPath = (input && typeof input === 'object') ? input.planPath : undefined
if (!planPath) {
  throw new Error(
    'args.planPath jest wymagane (sciezka do pliku planu). ' +
    'Otrzymano args typu "' + typeof args + '": ' + JSON.stringify(args)
  )
}
const wanted = (input && Array.isArray(input.layers) && input.layers.length) ? input.layers : ['dane', 'backend', 'frontend']
const present = new Set(wanted)

// --- Reguly wspolne (wstrzykiwane w prompty) ---
const ARCH_RULE = [
  'life-dashboard (Puls 2.0) to PWA React 19 + Vite (src/) na Fastify + PostgreSQL (server/), jeden origin, NIE Next.js.',
  'Przed zmianami przeczytaj docs/ARCHITECTURE.md (granice systemu, gospodarstwa/role, prywatne vs wspolne dane przez',
  'workspace_states/user_workspace_states, synchronizacja przez rewizje) i sprawdz istniejacy wzorzec w server/src/server.mjs.',
].join(' ')
const PRIVACY_RULE = 'Kazdy nowy prywatny rekord (i jego dzieci) musi respektowac granice visibility: private opisana w docs/ARCHITECTURE.md — identyfikator wlasciciela ustalany z sesji, nigdy z danych klienta.'
const REUSE_RULE = 'Reuzywaj istniejace utility/komponenty wskazane w planie zamiast pisac od zera. Prowadz wlasna todo-liste dla wieloetapowej pracy.'

// --- Schematy handoffu miedzy warstwami ---
const DATA_SCHEMA = {
  type: 'object',
  required: ['summary', 'files'],
  properties: {
    summary: { type: 'string', description: 'Co powstalo w warstwie danych' },
    tables: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'columns'],
        properties: {
          name: { type: 'string' },
          columns: { type: 'array', items: { type: 'string' }, description: 'np. "direction TEXT", "amount NUMERIC"' },
        },
      },
    },
    exports: { type: 'array', items: { type: 'string' }, description: 'Typy i funkcje z sygnaturami, np. "getUpcomingCarServices(workspaceId): Promise<CarService[]>"' },
    files: { type: 'array', items: { type: 'string' } },
    notesForBackend: { type: 'string', description: 'Co warstwa backend musi wiedziec (nazwy funkcji, ksztalt danych)' },
  },
}
const BACKEND_SCHEMA = {
  type: 'object',
  required: ['summary', 'files'],
  properties: {
    summary: { type: 'string' },
    endpoints: {
      type: 'array',
      items: {
        type: 'object',
        required: ['method', 'path'],
        properties: {
          method: { type: 'string' },
          path: { type: 'string' },
          responseShape: { type: 'string', description: 'np. "{ id, dueAt, note }[]"' },
          bodyShape: { type: 'string', description: 'ksztalt body dla POST/PATCH' },
        },
      },
    },
    backgroundJobs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          schedule: { type: 'string', description: 'np. opis harmonogramu/leasingu w workerze' },
          description: { type: 'string' },
        },
      },
      description: 'Zadania w tle/joby workera zarejestrowane lub zmienione w tej warstwie (server/src/worker.mjs)',
    },
    files: { type: 'array', items: { type: 'string' } },
    notesForFrontend: { type: 'string', description: 'Co warstwa frontend musi wiedziec (endpointy, ksztalty, kody bledow)' },
  },
}
const FRONTEND_SCHEMA = {
  type: 'object',
  required: ['summary', 'files'],
  properties: {
    summary: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    routes: { type: 'array', items: { type: 'string' }, description: 'Strony/sciezki dotkniete zmiana' },
    mobileChecked: { type: 'boolean', description: 'Czy UI dziala na waskim ekranie (PWA)' },
  },
}
const VERIFY_SCHEMA = {
  type: 'object',
  required: ['buildPass', 'testPass'],
  properties: {
    buildPass: { type: 'boolean' },
    testPass: { type: 'boolean' },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        properties: { file: { type: 'string' }, message: { type: 'string' } },
      },
    },
  },
}
const REPAIR_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
  },
}

// wspolne opcje agenta implementujacego (general-purpose => ma Edit/Write/Bash)
const impl = (label, phaseTitle, schema) => ({ label, phase: phaseTitle, schema, agentType: 'general-purpose', model: 'sonnet', effort: 'high' })

let data = null
let backend = null
let frontend = null

// --- Warstwa 1: dane (Baza + Logika) ---
if (present.has('dane')) {
  phase('Warstwa danych')
  data = await agent(
    [
      `Przeczytaj plan: ${planPath}. Zaimplementuj TYLKO warstwe danych: sekcje "Baza (warstwa danych)"`,
      'z sekcji "Pliki do zmiany" (nowa migracja SQL w server/migrations/, funkcje zapytan w server/src/db.mjs,',
      'ewentualne wspoldzielone typy w src/types.ts). NIE dotykaj route handlerow Fastify, workera ani frontendu.',
      'Nowa migracja to nowy plik server/migrations/00X_xxx.sql (kolejny numer) — nie edytuj istniejacych migracji.',
      REUSE_RULE,
      ARCH_RULE,
      PRIVACY_RULE,
      'Zwroc strukture: utworzone/zmienione tabele z kolumnami, wyeksportowane typy i funkcje (z sygnaturami), liste zmienionych plikow oraz uwagi dla warstwy backend (notesForBackend).',
    ].join('\n'),
    impl('impl:dane', 'Warstwa danych', DATA_SCHEMA)
  )
}

// --- Warstwa 2: backend (dostaje KONKRET z warstwy danych) ---
if (present.has('backend')) {
  phase('Warstwa backend')
  backend = await agent(
    [
      `Przeczytaj plan: ${planPath}, sekcja "Backend (warstwa backend)" z "Pliki do zmiany". Zaimplementuj TYLKO warstwe backendu:`,
      'route handlery Fastify w server/src/server.mjs ORAZ ewentualne joby workera w server/src/worker.mjs, middleware/autoryzacja w server/src/security.mjs, integracje zewnetrzne. NIE dotykaj frontendu.',
      data ? `Warstwa danych JEST GOTOWA — uzyj DOKLADNIE tych tabel, typow i funkcji (nie zgaduj nazw ani sygnatur):\n${JSON.stringify(data, null, 2)}` : 'Warstwa danych nie byla czescia tej orkiestracji — oprzyj sie na istniejacym kodzie i planie.',
      REUSE_RULE,
      ARCH_RULE,
      PRIVACY_RULE,
      'Zwroc: liste endpointow (metoda, sciezka, ksztalt request/response), liste jobow workera (backgroundJobs: nazwa, harmonogram, opis) jesli feature je dotyczy, zmienione pliki oraz uwagi dla warstwy frontend (notesForFrontend).',
    ].join('\n'),
    impl('impl:backend', 'Warstwa backend', BACKEND_SCHEMA)
  )
}

// --- Warstwa 3: frontend (dostaje konkret z backendu, a gdy brak backendu to z warstwy danych) ---
if (present.has('frontend')) {
  phase('Warstwa frontend')
  frontend = await agent(
    [
      `Przeczytaj plan: ${planPath}, sekcja "Frontend (warstwa frontend)" z "Pliki do zmiany". Zaimplementuj TYLKO komponenty i strony.`,
      backend ? `BACKEND JEST GOTOWY — wolaj dokladnie te endpointy i ksztalty:\n${JSON.stringify(backend.endpoints || backend, null, 2)}\nUwagi dla frontendu: ${backend.notesForFrontend || '(brak)'}` : '',
      (data && !backend) ? `Warstwa danych/logiki JEST GOTOWA:\n${JSON.stringify(data, null, 2)}` : '',
      REUSE_RULE,
      'To PWA — sprawdz, ze nowy UI zostaje uzyteczny na waskim ekranie (telefon). Reuzyj istniejace komponenty z src/components/. Ustaw mobileChecked=true tylko jesli faktycznie zadbales o waski ekran.',
      ARCH_RULE,
      'Zwroc: zmienione pliki, dotkniete sciezki/strony i krotki opis co powstalo.',
    ].filter(Boolean).join('\n'),
    impl('impl:frontend', 'Warstwa frontend', FRONTEND_SCHEMA)
  )
}

// --- Weryfikacja + ograniczona petla napraw (build + testy; e2e/preview zostaje glownemu agentowi) ---
phase('Weryfikacja')
let verify = null
const MAX_ROUNDS = 3
for (let round = 1; round <= MAX_ROUNDS; round++) {
  verify = await agent(
    [
      'Uruchom po kolei `npm run build` (tsc -b && vite build, to rowniez typecheck), a nastepnie `npm test` (frontend, vitest) i `npm run test:server` (backend, node --test).',
      'NIE naprawiaj bledow — tylko raportuj. Zwroc buildPass/testPass oraz pelna liste bledow (plik + komunikat).',
    ].join('\n'),
    { label: `verify:r${round}`, phase: 'Weryfikacja', schema: VERIFY_SCHEMA, agentType: 'general-purpose', model: 'sonnet' }
  )
  if (verify && verify.buildPass && verify.testPass) {
    log(`Weryfikacja zielona w rundzie ${round}`)
    break
  }
  if (round === MAX_ROUNDS) {
    log(`Weryfikacja nadal czerwona po ${round} rundach — przekazuje bledy glownemu agentowi`)
    break
  }
  log(`Runda ${round}: build/testy czerwone (${(verify && verify.errors ? verify.errors.length : '?')} bledow) — deleguje naprawe`)
  await agent(
    [
      `Napraw bledy build/testy powstale przy implementacji feature (plan: ${planPath}).`,
      `Bledy do naprawy:\n${JSON.stringify(verify.errors || [], null, 2)}`,
      `Kontekst zaimplementowanych warstw:\n${JSON.stringify({ data, backend, frontend }, null, 2)}`,
      ARCH_RULE,
      'Zmien tylko to, co konieczne, zeby `npm run build`, `npm test` i `npm run test:server` przeszly. NIE zmieniaj zachowania feature ani zakresu z planu.',
    ].join('\n'),
    { label: `repair:r${round}`, phase: 'Weryfikacja', schema: REPAIR_SCHEMA, agentType: 'general-purpose', model: 'sonnet', effort: 'high' }
  )
}

return { planPath, layers: [...present], data, backend, frontend, verify }
