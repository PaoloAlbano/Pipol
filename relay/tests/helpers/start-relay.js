// Starts relay/server.js as a child process on a free port with the given environment.

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const relayDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/**
 * @param {Record<string,string>} env  Extra environment for the relay
 * @returns {Promise<{ port: number, output: () => string, stop: () => Promise<void> }>}
 */
export async function startRelay(env = {}) {
  const port = await freePort()
  let output = ''
  const child = spawn(process.execPath, ['server.js'], {
    cwd: relayDir,
    env: {
      ...process.env,
      PORT: String(port),
      CF_TURN_KEY_ID: '',
      CF_TURN_API_TOKEN: '',
      ICE_ALLOWED_ORIGINS: '',
      ICE_RATE_LIMIT: '',
      TRUST_PROXY_HOPS: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (c) => (output += c))
  child.stderr.on('data', (c) => (output += c))

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay did not start in time')), 30_000)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`relay exited early (code ${code})`))
    })
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('Listening on port')) {
        clearTimeout(timer)
        resolve(undefined)
      }
    })
  })

  return {
    port,
    output: () => output,
    async stop() {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGINT')
      await exited
    },
  }
}
