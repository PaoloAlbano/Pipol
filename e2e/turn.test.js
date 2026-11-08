// @ts-check
/**
 * TURN end-to-end tests against a real coturn server (Docker) and the real relay.
 *
 * Opt-in because they need Docker and network access to pull the coturn image:
 *
 *   make turn-e2e          (or: TURN_E2E=1 pnpm exec playwright test e2e/turn.test.js)
 *
 * What runs:
 *   coturn (TURN REST secret) ← relay/server.js (TURN_PROVIDER=coturn, GET /ice) ← the app's src/webrtc/ice.js in Chromium
 *
 * It also makes real video calls between two browsers that may only use the relay ("always relay"): the call
 * connects, restarts ICE after a change of network and connects again after a failure, all through coturn.
 */
import { test, expect } from '@playwright/test'
import { spawn, execFileSync } from 'node:child_process'
import { createConnection } from 'node:net'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { joinQuickRoom } from './helpers.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const COTURN_NAME = 'pipol-coturn-e2e'
const COTURN_PORT = 3478
const RELAY_PORT = 18787
const SECRET = 'e2e-shared-secret'
const TURN_URL = `turn:127.0.0.1:${COTURN_PORT}?transport=tcp`

/** @type {import('node:child_process').ChildProcess | null} */
let relay = null

test.skip(!process.env.TURN_E2E, 'Set TURN_E2E=1 to run (needs Docker)')
test.describe.configure({ mode: 'serial' })

function waitForPort(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createConnection({ port, host: '127.0.0.1' })
      socket.once('connect', () => {
        socket.destroy()
        resolve(undefined)
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() > deadline) reject(new Error(`port ${port} did not open`))
        else setTimeout(attempt, 300)
      })
    }
    attempt()
  })
}

/** Credentials as a TURN REST API client (coturn `use-auth-secret`) would mint them. */
function restCredentials(secret, ttlSeconds = 3600) {
  const username = `${Math.floor(Date.now() / 1000) + ttlSeconds}:e2e`
  return { username, credential: crypto.createHmac('sha1', secret).update(username).digest('base64') }
}

test.beforeAll(async () => {
  test.setTimeout(120_000)

  execFileSync('docker', ['rm', '-f', COTURN_NAME], { stdio: 'ignore' })
  execFileSync('docker', [
    'run',
    '-d',
    '--rm',
    '--name',
    COTURN_NAME,
    '-p',
    `${COTURN_PORT}:${COTURN_PORT}`,
    '-p',
    `${COTURN_PORT}:${COTURN_PORT}/udp`,
    'coturn/coturn',
    '-n',
    '--log-file=stdout',
    '--use-auth-secret',
    `--static-auth-secret=${SECRET}`,
    '--realm=pipol.test',
    `--listening-port=${COTURN_PORT}`,
    '--no-tls',
    '--min-port=49160',
    '--max-port=49200',
    '--no-cli',
    '-V', // log every request so the tests can see refusals
    // Hardening from relay/turnserver.example.conf. 172.16/12 is left out on purpose: the two test
    // peers reach each other through relayed addresses on Docker's own 172.x network.
    '--no-multicast-peers',
    '--denied-peer-ip=127.0.0.0-127.255.255.255',
    '--denied-peer-ip=169.254.0.0-169.254.255.255',
    '--denied-peer-ip=10.0.0.0-10.255.255.255',
    '--denied-peer-ip=192.168.0.0-192.168.255.255',
    '--user-quota=12',
    '--max-bps=3000000',
  ])
  await waitForPort(COTURN_PORT)

  relay = spawn('node', ['relay/server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(RELAY_PORT),
      TURN_PROVIDER: 'coturn',
      TURN_URLS: TURN_URL,
      TURN_SECRET: SECRET,
      CLOUDFLARE_TURN_KEY_ID: '',
      CLOUDFLARE_TURN_API_TOKEN: '',
    },
    stdio: 'ignore',
  })
  await waitForPort(RELAY_PORT, 60_000)
})

test.afterAll(() => {
  relay?.kill('SIGINT')
  try {
    execFileSync('docker', ['rm', '-f', COTURN_NAME], { stdio: 'ignore' })
  } catch {
    // already gone
  }
})

test.describe('TURN with a real coturn', () => {
  test('the relay /ice endpoint hands out credentials that coturn accepts', async ({ page, request }) => {
    const res = await request.get(`http://127.0.0.1:${RELAY_PORT}/ice`)
    expect(res.ok()).toBeTruthy()
    expect(res.headers()['access-control-allow-origin']).toBe('*')
    const body = await res.json()
    expect(body.iceServers[0].urls).toEqual([TURN_URL])

    await page.goto('/')
    const result = await page.evaluate(async (relayUrl) => {
      const ice = await import('/src/webrtc/ice.js')
      ice.clearIceCache()
      const config = await ice.resolveIceConfig({
        relayUrl,
        settings: { mode: 'default', servers: [], forceRelay: false, chatTurn: false },
      })
      return { hasTurn: ice.hasTurnServer(config.iceServers), probe: await ice.testIceServers(config, 10_000) }
    }, `ws://127.0.0.1:${RELAY_PORT}`)

    expect(result.hasTurn).toBe(true)
    expect(result.probe.relay).toBe(true)
  })

  test('a custom server with valid credentials works (bring your own coturn)', async ({ page }) => {
    await page.goto('/')
    const server = { urls: [TURN_URL], ...restCredentials(SECRET) }
    const probe = await page.evaluate(
      async (servers) => {
        const ice = await import('/src/webrtc/ice.js')
        const config = await ice.resolveIceConfig({
          settings: { mode: 'custom', servers, forceRelay: false, chatTurn: false },
        })
        return ice.testIceServers(config, 10_000)
      },
      [server]
    )

    expect(probe.relay).toBe(true)
  })

  test('wrong credentials are rejected, so "Test connection" reports no relay', async ({ page }) => {
    await page.goto('/')
    const server = { urls: [TURN_URL], username: `${Math.floor(Date.now() / 1000) + 3600}:e2e`, credential: 'nope' }
    const probe = await page.evaluate(
      async (servers) => {
        const ice = await import('/src/webrtc/ice.js')
        const config = await ice.resolveIceConfig({
          settings: { mode: 'custom', servers, forceRelay: false, chatTurn: false },
        })
        return ice.testIceServers(config, 10_000)
      },
      [server]
    )

    expect(probe.relay).toBe(false)
  })

  test('expired credentials are rejected by coturn', async ({ page }) => {
    await page.goto('/')
    const expired = restCredentials(SECRET, -60) // correctly signed, but the timestamp is in the past
    const probe = await page.evaluate(
      async (servers) => {
        const ice = await import('/src/webrtc/ice.js')
        const config = await ice.resolveIceConfig({
          settings: { mode: 'custom', servers, forceRelay: false, chatTurn: false },
        })
        return ice.testIceServers(config, 10_000)
      },
      [{ urls: [TURN_URL], ...expired }]
    )

    expect(probe.relay).toBe(false)
  })

  test('a tampered signature is rejected by coturn', async ({ page }) => {
    await page.goto('/')
    const { username, credential } = restCredentials(SECRET)
    const tampered = credential.slice(0, -4) + (credential.endsWith('AAA=') ? 'BBB=' : 'AAA=')
    const probe = await page.evaluate(
      async (servers) => {
        const ice = await import('/src/webrtc/ice.js')
        const config = await ice.resolveIceConfig({
          settings: { mode: 'custom', servers, forceRelay: false, chatTurn: false },
        })
        return ice.testIceServers(config, 10_000)
      },
      [{ urls: [TURN_URL], username, credential: tampered }]
    )

    expect(probe.relay).toBe(false)
  })

  test('coturn refuses to relay towards internal addresses, and still relays towards public ones', async ({ page }) => {
    await page.goto('/')
    const server = { urls: [TURN_URL], ...restCredentials(SECRET) }

    /** Number of "Forbidden IP" refusals coturn has logged so far. */
    const refusals = () =>
      (
        execFileSync('docker', ['logs', COTURN_NAME], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).match(
          /Forbidden IP/g
        ) ?? []
      ).length

    async function offerPeer(address) {
      const before = refusals()
      await page.evaluate(
        async ({ servers, address }) => {
          const ice = await import('/src/webrtc/ice.js')
          const config = await ice.resolveIceConfig({
            settings: { mode: 'custom', servers, forceRelay: true, chatTurn: false },
          })
          const a = new RTCPeerConnection(config)
          const b = new RTCPeerConnection()
          a.createDataChannel('x')
          await a.setLocalDescription(await a.createOffer())
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 8000)
            a.onicecandidate = (e) => {
              if (!e.candidate) {
                clearTimeout(timer)
                resolve(undefined)
              }
            }
          })
          await b.setRemoteDescription(a.localDescription)
          await b.setLocalDescription(await b.createAnswer())
          await a.setRemoteDescription(b.localDescription)
          // A peer "at" this address: our TURN allocation must ask coturn for permission to talk to it
          await a.addIceCandidate({
            candidate: `candidate:9 1 udp 2113937151 ${address} 50000 typ host`,
            sdpMid: '0',
            sdpMLineIndex: 0,
          })
          await new Promise((r) => setTimeout(r, 1500))
          a.close()
          b.close()
        },
        { servers: [server], address }
      )
      return refusals() - before
    }

    expect(await offerPeer('8.8.8.8')).toBe(0) // control: a public peer is fine
    expect(await offerPeer('169.254.169.254')).toBeGreaterThan(0) // cloud metadata endpoint
    expect(await offerPeer('127.0.0.1')).toBeGreaterThan(0) // the TURN host itself
    expect(await offerPeer('10.1.2.3')).toBeGreaterThan(0) // private network
  })

  test('"off" never uses TURN, even when the relay offers one', async ({ page }) => {
    await page.goto('/')
    const hasTurn = await page.evaluate(async (relayUrl) => {
      const ice = await import('/src/webrtc/ice.js')
      ice.clearIceCache()
      const config = await ice.resolveIceConfig({
        relayUrl,
        settings: { mode: 'off', servers: [], forceRelay: false, chatTurn: false },
      })
      return ice.hasTurnServer(config.iceServers)
    }, `ws://127.0.0.1:${RELAY_PORT}`)

    expect(hasTurn).toBe(false)
  })

  test('"always relay" exposes only relayed candidates (no host or srflx addresses)', async ({ page }) => {
    await page.goto('/')
    const server = { urls: [TURN_URL], ...restCredentials(SECRET) }
    const types = await page.evaluate(
      async (servers) => {
        const ice = await import('/src/webrtc/ice.js')
        const config = await ice.resolveIceConfig({
          settings: { mode: 'custom', servers, forceRelay: true, chatTurn: false },
        })
        const pc = new RTCPeerConnection(config)
        pc.createDataChannel('x')
        const seen = new Set()
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 10_000)
          pc.onicecandidate = (e) => {
            if (!e.candidate) {
              clearTimeout(timer)
              resolve(undefined)
            } else seen.add(e.candidate.type)
          }
          pc.createOffer().then((o) => pc.setLocalDescription(o))
        })
        pc.close()
        return { policy: config.iceTransportPolicy, types: [...seen] }
      },
      [server]
    )

    expect(types.policy).toBe('relay')
    expect(types.types).toEqual(['relay'])
  })

  test('two peers connect and exchange data through coturn when only relaying is allowed', async ({ page }) => {
    await page.goto('/')
    const server = { urls: [TURN_URL], ...restCredentials(SECRET) }
    const result = await page.evaluate(
      async (servers) => {
        const ice = await import('/src/webrtc/ice.js')
        const config = await ice.resolveIceConfig({
          settings: { mode: 'custom', servers, forceRelay: true, chatTurn: false },
        })

        const a = new RTCPeerConnection(config)
        const b = new RTCPeerConnection(config)
        a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate)
        b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate)

        const received = new Promise((resolve) => {
          b.ondatachannel = (e) => {
            e.channel.onmessage = (m) => resolve(m.data)
          }
        })
        const channel = a.createDataChannel('chat')
        const opened = new Promise((resolve) => (channel.onopen = resolve))

        await a.setLocalDescription(await a.createOffer())
        await b.setRemoteDescription(a.localDescription)
        await b.setLocalDescription(await b.createAnswer())
        await a.setRemoteDescription(b.localDescription)

        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('no connection via TURN')), 20_000)
        )
        await Promise.race([opened, timeout])
        channel.send('through-turn')
        const message = await Promise.race([received, timeout])

        const stats = await a.getStats()
        let route = null
        stats.forEach((s) => {
          if (s.type === 'candidate-pair' && s.nominated) {
            route = {
              local: stats.get(s.localCandidateId)?.candidateType,
              remote: stats.get(s.remoteCandidateId)?.candidateType,
            }
          }
        })
        a.close()
        b.close()
        return { message, route }
      },
      [server]
    )

    expect(result.message).toBe('through-turn')
    expect(result.route?.local).toBe('relay')
    expect(result.route?.remote).toBe('relay')
  })
})

// ── Calls through TURN ────────────────────────────────────────────────────────

const ICE_SETTINGS_KEY = 'p2p-chat:ice-settings'

/** Keeps the RTCPeerConnections of the page and tells which carry the call (those with our camera) and how. */
function recordPeerConnections() {
  const Native = window.RTCPeerConnection
  window.__pcs = []
  function Recording(...args) {
    const pc = new Native(...args)
    window.__pcs.push(pc)
    return pc
  }
  Recording.prototype = Native.prototype
  Object.setPrototypeOf(Recording, Native)
  window.RTCPeerConnection = Recording

  // Not counting the ones we made fail
  window.__liveCall = () =>
    window.__pcs.filter(
      (p) => !p.__failed && p.connectionState !== 'closed' && p.getSenders().some((s) => s.track?.kind === 'video')
    )
  /** The candidate pair in use, as "local<->remote" types, and the types of all our candidates. */
  window.__route = async () => {
    const pc = window.__liveCall()[0]
    if (!pc) return null
    const items = [...(await pc.getStats()).values()]
    const byId = Object.fromEntries(items.map((s) => [s.id, s]))
    const pair = byId[items.find((s) => s.type === 'transport')?.selectedCandidatePairId]
    return {
      pair: pair
        ? `${byId[pair.localCandidateId]?.candidateType}<->${byId[pair.remoteCandidateId]?.candidateType}`
        : null,
      gathered: [...new Set(items.filter((s) => s.type === 'local-candidate').map((s) => s.candidateType))],
    }
  }
}

const callState = () => window.__liveCall()[0]?.connectionState
const ufrag = () => /a=ice-ufrag:(\S+)/.exec(window.__liveCall()[0]?.localDescription?.sdp ?? '')?.[1]

function failTheCall() {
  const pc = window.__liveCall()[0]
  pc.__failed = true
  Object.defineProperty(pc, 'connectionState', { get: () => 'failed', configurable: true })
  pc.dispatchEvent(new Event('connectionstatechange'))
}

async function remoteVideoPlays(page) {
  const video = page.locator('.video-tile:not(:has-text("(you)")) video').first()
  await expect(video).toHaveCount(1, { timeout: 20_000 })
  const before = await video.evaluate((v) => v.currentTime)
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 20_000 }).toBeGreaterThan(before)
}

test.describe('Calls through a real coturn', () => {
  test.setTimeout(180_000)

  /** Two browsers that may only use the TURN server ("always relay"), in a call. */
  async function callThroughTurn(browser) {
    const settings = {
      mode: 'custom',
      servers: [{ urls: [TURN_URL], ...restCredentials(SECRET) }],
      forceRelay: true,
      chatTurn: false,
    }
    const contexts = [await browser.newContext(), await browser.newContext()]
    for (const ctx of contexts) {
      await ctx.addInitScript(recordPeerConnections)
      await ctx.addInitScript(
        ([key, value]) => localStorage.setItem(key, value),
        [ICE_SETTINGS_KEY, JSON.stringify(settings)]
      )
    }
    const [pageA, pageB] = await Promise.all(contexts.map((c) => c.newPage()))
    const room = `e2e-${Date.now()}-turn-call`
    await Promise.all([joinQuickRoom(pageA, room, 'alice-e2e'), joinQuickRoom(pageB, room, 'bob-e2e')])
    await pageA.waitForTimeout(2500)
    await pageA.getByRole('button', { name: /start video call/i }).click({ timeout: 15_000 })
    await pageB.getByRole('button', { name: 'Join', exact: true }).first().click({ timeout: 20_000 })
    await expect.poll(() => pageA.evaluate(callState), { timeout: 40_000 }).toBe('connected')
    await expect.poll(() => pageB.evaluate(callState), { timeout: 40_000 }).toBe('connected')
    return { contexts, pageA, pageB }
  }

  const closeAll = (contexts) => Promise.all(contexts.map((c) => c.close()))

  test('a call connects and the video flows, with every packet going through coturn', async ({ browser }) => {
    const { contexts, pageA, pageB } = await callThroughTurn(browser)
    try {
      for (const page of [pageA, pageB]) {
        const route = await page.evaluate(() => window.__route())
        expect(route.pair).toBe('relay<->relay')
        expect(route.gathered).toEqual(['relay']) // no host or server-reflexive address was even gathered
      }
      await remoteVideoPlays(pageA)
      await remoteVideoPlays(pageB)
    } finally {
      await closeAll(contexts)
    }
  })

  test('a change of network restarts ICE through coturn and the video keeps flowing', async ({ browser }) => {
    const { contexts, pageA, pageB } = await callThroughTurn(browser)
    try {
      const before = { a: await pageA.evaluate(ufrag), b: await pageB.evaluate(ufrag) }
      expect(before.a).toBeTruthy()

      await Promise.all([pageA, pageB].map((p) => p.evaluate(() => window.dispatchEvent(new Event('online')))))

      await expect.poll(() => pageA.evaluate(ufrag), { timeout: 30_000 }).not.toBe(before.a)
      await expect.poll(() => pageB.evaluate(ufrag), { timeout: 30_000 }).not.toBe(before.b)
      await expect.poll(() => pageA.evaluate(callState), { timeout: 30_000 }).toBe('connected')
      await expect.poll(() => pageB.evaluate(callState), { timeout: 30_000 }).toBe('connected')
      expect((await pageA.evaluate(() => window.__route())).pair).toBe('relay<->relay')
      await remoteVideoPlays(pageA)
      await remoteVideoPlays(pageB)
    } finally {
      await closeAll(contexts)
    }
  })

  test('a connection that fails is made again through coturn, and the picture comes back', async ({ browser }) => {
    const { contexts, pageA, pageB } = await callThroughTurn(browser)
    try {
      await remoteVideoPlays(pageA)
      await pageA.evaluate(failTheCall)
      await expect(pageA.getByText('Reconnecting…')).toBeVisible({ timeout: 15_000 })

      // The restarts do not help (the failure is only reported), then a new connection is made
      await expect(pageA.getByText('Reconnecting…')).toBeHidden({ timeout: 120_000 })
      await expect.poll(() => pageA.evaluate(callState), { timeout: 40_000 }).toBe('connected')
      await expect.poll(() => pageB.evaluate(callState), { timeout: 40_000 }).toBe('connected')
      expect((await pageA.evaluate(() => window.__route())).pair).toBe('relay<->relay')
      await remoteVideoPlays(pageA)
      await remoteVideoPlays(pageB)
    } finally {
      await closeAll(contexts)
    }
  })
})
