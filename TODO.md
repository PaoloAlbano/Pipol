# TODO — Workspace + Enterprise Features

---

## Blocco 0 — Workspace access control

Due meccanismi, in ordine di implementazione.

### Opzione C — Invite URL (da fare prima)

L'access control è possedere l'invite URL. Il workspace secret è incorporato nel payload base64 — i roomCode dei canali sono derivati da esso, quindi non indovinabili senza il segreto.

L'invite URL è anche un **bootstrap di configurazione**: contiene gli endpoint dei server (relay, auth) da usare per quel workspace, sovrascrivendo i default dell'app. Un admin self-hosted condivide semplicemente il proprio URL e l'app si configura automaticamente.

**Formato invite URL:**
```
https://pipol.dev/?invite=<base64url(JSON)>
```

**Payload JSON:**
```json
{
  "v": 1,
  "secret": "a3f9b2c8...",
  "name": "Acme Corp",
  "channels": ["generale", "random"],
  "config": {
    "relayUrl": "wss://relay.acme.com",
    "authUrl": "https://auth.acme.com"
  }
}
```

- `v` — versione schema (per forward compatibility)
- `secret` — 32 byte hex random, deriva tutti i roomCode e il workspace swarm topic
- `name` — nome visualizzato del workspace
- `channels` — lista canali seed (visibili subito, anche offline)
- `config` — opzionale; se assente si usano i default dell'app (`VITE_RELAY_URL`, `VITE_AUTH_URL`)

**Derivazioni:**
```
workspaceSwarmTopic = BLAKE2b(secret + ':meta')
channelRoomCode(name) = BLAKE2b(secret + ':ch:' + name).hex().slice(0, 20)
```

**Regole canali:**
- Chiunque nel workspace può creare un canale (append-only)
- I canali non si possono cancellare (solo nascondere localmente)
- Lista canali = union di tutti i `WORKSPACE_META` ricevuti dai peer (CRDT monotonic)

**Flusso:**
```
1. Admin crea workspace nell'app → genera secret random → costruisce payload → encode base64url → condivide URL
2. Utente apre l'URL → app decodifica payload → mostra "Vuoi unirti a Acme Corp?" → conferma
3. Workspace salvato in localStorage con secret + config
4. App si connette al workspace swarm (topic derivato dal secret)
5. Riceve WORKSPACE_META dai peer → aggiorna lista canali
6. Config (relayUrl, authUrl) sovrascrive i default per questo workspace
```

**Revoca accesso:** rotazione del secret → nuovo invite URL → il vecchio non funziona più

**Tasks:**
- [ ] Definire e documentare lo schema JSON del payload (versioning incluso)
- [ ] `src/p2p/workspace.js` — `createWorkspace(name, channels, config?)` → genera secret, costruisce payload, restituisce invite URL
- [ ] `src/p2p/workspace.js` — `parseInviteUrl(url)` → valida e decodifica payload, restituisce workspace object
- [ ] `src/p2p/workspace.js` — `deriveSwarmTopic(secret)` → topic per il workspace swarm
- [ ] `src/p2p/workspace.js` — `deriveChannelRoomCode(secret, channelName)` → roomCode hex
- [ ] `src/p2p/workspace.js` — `mergeChannelList(local, received)` → union CRDT (append-only, no delete)
- [ ] `src/p2p/workspace.js` — `getEffectiveConfig(workspaceId)` → config workspace con fallback ai default app
- [ ] Struttura workspace in localStorage:
  ```json
  {
    "id": "uuid-v4",
    "name": "Acme Corp",
    "secret": "a3f9b2c8...",
    "channels": [{ "name": "generale", "topic": "", "createdAt": 123, "createdBy": "pubkey" }],
    "config": { "relayUrl": "...", "authUrl": "..." },
    "joinedAt": 1234567890
  }
  ```
- [ ] Workspace swarm: messaggio `WORKSPACE_META { channels[], updatedAt }` — inviato al join e quando si crea un canale
- [ ] Workspace swarm: messaggio `MEMBER_HELLO { pubkey, username, status }` — inviato al join
- [ ] Workspace swarm: messaggio `PRESENCE_UPDATE { pubkey, status }` — inviato al cambio status
- [ ] Member directory locale in IndexedDB: `{ pubkey, username, lastSeen, status, workspaceId }`

---

### Opzione B — Auth server restituisce workspace dopo OIDC login (da fare dopo)

Il Cloudflare Worker (`auth/`) diventa il gatekeeper: conosce quali workspace esistono e chi può accedervi. I roomCode sono derivati server-side — il client non può calcolarli senza prima autenticarsi.

Il config override (relayUrl, authUrl) funziona allo stesso modo: il server include `config` nel response, il client lo applica esattamente come farebbe con l'invite URL dell'Opzione C.

**Flusso:**
```
Utente fa login OIDC → /derive restituisce serverSecret + workspaces[]
workspaces[] contiene già i roomCode derivati (HMAC del workspace secret) + config
Il client non conosce mai il workspaceSecret grezzo
```

**Auth server (Cloudflare Worker + KV):**

- [ ] Aggiungere KV binding `WORKSPACES_KV` al Worker (`auth/wrangler.toml`)
- [ ] Schema KV:
  - `ws:{workspaceId}` → `{ name, secret, channels: [{name, topic}], config: {relayUrl?, authUrl?}, createdAt }`
  - `member:{userPubKey}` → `[workspaceId, ...]`
- [ ] Nuovo endpoint `POST /workspaces/create`:
  - Richiede bearer token (solo admin configurati in env)
  - Crea workspace, genera secret, salva in KV
  - Restituisce `{ workspaceId, inviteUrl }` — stesso formato Opzione C
- [ ] Nuovo endpoint `POST /workspaces/join`:
  - Body: `{ invitePayload }` — stesso payload base64 dell'Opzione C
  - Registra membership utente in KV
  - Restituisce workspace config con roomCode derivati
- [ ] Modificare `/derive` per includere workspaces nel response:
  ```json
  {
    "serverSecret": "...",
    "keyVersion": "v1",
    "workspaces": [
      {
        "id": "acme",
        "name": "Acme Corp",
        "channels": [
          { "name": "generale", "roomCode": "a3f9b2..." }
        ],
        "config": { "relayUrl": "wss://relay.acme.com" },
        "role": "member"
      }
    ]
  }
  ```
- [ ] `auth/src/derive.js` — aggiungere lookup membership + derivazione roomCode con HMAC
- [ ] `src/p2p/oidc.js` — gestire `workspaces` nel response di `/derive`, passarli a `workspace.js`

---

## Blocco 1 — Layout Workspace

### Step 1 — Storage workspace (client)
- [x] Creare `src/p2p/workspace.js` (vedi tasks Blocco 0 Opzione C sopra)
- [x] Persistenza: `localStorage` chiave `p2p-chat:workspaces`
- [x] Funzioni CRUD: `getWorkspaces()`, `saveWorkspace(ws)`, `removeWorkspace(id)`, `getActiveWorkspaceId()`, `setActiveWorkspaceId(id)`

### Step 2 — Design tokens
- [x] Aggiornare `src/styles/global.css` con i nuovi token CSS
  - [x] 5 livelli superficie (`--bg`, `--surface` … `--surface-5`)
  - [x] Colori stato (`--success`, `--warning`, `--danger`, `--accent`)
  - [x] `--primary`, `--primary-dim`, `--primary-glow`
  - [x] Tipografia, radius, ombre, border aggiornati

### Step 3 — WorkspaceLayout shell
- [x] Creare `src/components/WorkspaceLayout.jsx`
- [x] Creare `src/styles/workspace.css`
  - [x] 4 zone: rail (48px) + sidebar (220px) + main (flex:1) + right panel (300px, opzionale)
  - [x] Responsive: tablet (sidebar collassabile) + mobile (bottom nav)

### Step 4 — WorkspaceRail
- [x] Creare `src/components/WorkspaceRail.jsx`
  - [x] Avatar workspace con iniziali + colore da hash del workspaceId
  - [x] Pill laterale stile Discord per workspace attivo
  - [x] Pulsante `+` per join/crea workspace
  - [x] Pulsante settings in fondo
  - [x] Tooltip al hover

### Step 5 — ChannelSidebar
- [x] Creare `src/components/ChannelSidebar.jsx`
- [x] Creare `src/styles/sidebar.css`
  - [x] WorkspaceHeader (nome + contatore online)
  - [x] Sezione canali collassabile con badge non letti
  - [x] Sezione DM collassabile con indicatore presenza
  - [x] Pulsante `+` crea canale / nuovo DM
  - [x] UserCard in fondo (avatar, username, toggle mic/deaf)
  - [x] Unread badge per canale (counter in localStorage, azzera al click)

### Step 6 — ChannelHeader
- [x] Creare `src/components/ChannelHeader.jsx`
  - [x] Nome canale + icona tipo (# o lucchetto)
  - [x] Topic (click → modifica inline, broadcast `CHANNEL_META`)
  - [x] Icone azione: search, members, video call, info

### Step 7 — Avatar + Identicon
- [x] Creare `src/components/Avatar.jsx`
  - [x] Colore da `hue = parseInt(pubkey.slice(0,4), 16) % 360`
  - [x] Iniziali da username (max 2 lettere)
  - [x] Varianti size: sm / md / lg / xl
  - [x] Status dot opzionale (online / away / offline)

### Step 8 — Refactor App.jsx
- [x] Aggiungere view `workspace` tra `home` e `room`
- [x] Al mount: se `?invite=` presente in URL → parse + mostra modal "Vuoi unirti a X?"
- [x] Quando si seleziona canale: montare `Room` nell'area main senza smontare `WorkspaceLayout`
- [x] Cambiare `Room` key al cambio canale (come ora)
- [x] Gestire URL: `?ws=wsId&ch=channelName` per deep link canale
- [x] Config workspace (relayUrl, authUrl) applicata quando si entra nel workspace

### Step 9 — Refactor Home.jsx → OnboardingScreen
- [x] Se utente ha già workspace salvati → skip diretto a WorkspaceLayout
- [x] Se non ha workspace → schermata "Crea workspace" / "Entra con invite URL"
- [x] Flusso "Crea workspace": nome → canali seed (default generale+random)
- [x] Flusso "Entra con invito": incolla URL o il ?invite= è già nell'URL → confirm modal

### Step 11 — CreateWorkspaceModal
- [x] Creare `src/components/CreateWorkspaceModal.jsx`
  - [x] Step 1: nome workspace (input + validazione)
  - [x] Step 2: canali seed (lista editabile, aggiungi/rimuovi, default: "generale" + "random")
  - [x] Step 3 (opzionale, collassabile): configurazione avanzata
    - [x] Custom relay URL
    - [x] Custom auth URL
  - [x] Genera invite URL via `createWorkspace()` + `buildInviteUrl()`
  - [x] Schermata risultato: mostra URL con pulsante copia, tasto "Apri in nuova tab" per test
  - [x] Accessibile anche da workspace già esistente (per rigenerare il link o aggiornarlo dopo nuovi canali)
- [x] Creare `src/styles/create-workspace-modal.css`

### Step 10 — Adattamenti Room.jsx
- [x] Sidebar interna nascosta con prop `embedded`
- [x] Mobile header nascosto con prop `embedded`
- [x] `onLeave` → torna ai canali (non naviga a Home)
- [x] Logica P2P interna invariata

---

## Blocco 2 — Comunicazione asincrona

- [x] **DM 1:1** — bilateral room derivata da `BLAKE2b(secret + ':dm:' + sort([keyA, keyB]))[0:20]`
  - [x] Discovery tramite member directory del workspace swarm
  - [x] UI: click su utente in sidebar → apre DM
  - [x] Fix privacy: workspace secret incluso nella derivazione — solo i membri del workspace possono calcolare il room code
- [x] **Indicatore presenza** — peer online/offline visibile in sidebar e DM
- [x] **Typing indicator** — messaggio effimero `TYPING` via DataChannel, `stopped: true` per clear immediato all'invio
- [x] **@mention** — parsing `@username`, evidenziazione in `ChatMessages`, autocomplete dropdown in `ChatInput`
- [ ] **Notifiche browser** — `Notification` API, permesso utente
- [ ] **Badge app non letti** — `navigator.setAppBadge()`

---

## Blocco 3 — Messaggistica ricca

- [ ] **Thread** — `parentId` sui messaggi, pannello thread laterale (RightPanel), preview "N risposte"
- [ ] **Reazioni emoji** — messaggio tipo `REACTION { targetId, emoji, userId }`, aggregazione client
- [ ] **Modifica messaggio** — tombstone `MSG_EDIT`, UI mostra "(modificato)"
- [ ] **Elimina messaggio** — tombstone `MSG_DELETE`, UI nasconde contenuto
- [ ] **Messaggi fissati** — `MSG_PIN`, lista visibile nell'header canale
- [ ] **Bozze** — salvataggio automatico in localStorage per canale
- [ ] **Invio file** — chunking via DataChannel, anteprima immagini inline, drag & drop
- [ ] **Ricerca full-text** — Fuse.js su IndexedDB, filtri data/utente/canale, Cmd+K

---

## Blocco 4 — Video call migliorata

- [ ] **Call lobby** — anteprima cam/mic prima di entrare, lista chi è già nella call
- [ ] **Raise hand** — messaggio `HAND_RAISE`, badge sul tile video
- [ ] **Reazioni emoji in-call** — `CALL_REACTION`, animazione floating sul tile
- [ ] **Controlli host** — mute all, kick, blocca meeting, termina per tutti
- [ ] **Waiting room / lobby approval** — `JOIN_REQ` / `JOIN_ACCEPT` / `JOIN_DENY`
- [ ] **Keyboard shortcuts** — `Cmd+D` mute mic, `Cmd+E` mute cam, `Cmd+Shift+H` raise hand
- [ ] **Timer meeting** — elapsed time nell'header della call
- [ ] **Mirror self-view** — CSS `scaleX(-1)` sul video locale
- [ ] **Indicatore qualità connessione** — semaforo per tile da RTT/packetLoss
- [ ] **Registrazione locale** — `MediaRecorder`, download `.webm`
- [ ] **Huddle** — call solo audio, barra persistente `HuddleBar` in fondo

---

## Blocco 5 — Enterprise / Avanzato

- [ ] **Cancellazione rumore** — RNNoise (WASM), processing audio pre-invio
- [ ] **Background blur** — MediaPipe WASM, segmentazione persona
- [ ] **Sfondi virtuali** — stessa pipeline del blur
- [ ] **Integrazione calendario** — OAuth PKCE Google/Microsoft, crea meeting da app
- [ ] **Link meeting permanente** — room derivata dalla pubkey utente
- [ ] **Ruoli e permessi** — owner/moderator/member verificabili crittograficamente
- [ ] **Data retention** — pulizia automatica IndexedDB dopo N giorni
- [ ] **Export dati** — dump JSON da IndexedDB (Settings)
- [ ] **Sottotitoli live** — Web Speech API, broadcast `CAPTION { text, peerId }`
- [ ] **SFU per >8 partecipanti** — LiveKit self-hosted (grossa infrastruttura, low priority)
- [ ] **Relay workspace meta** — server opzionale che cachea solo `WORKSPACE_META` (niente messaggi) per bootstrap offline
