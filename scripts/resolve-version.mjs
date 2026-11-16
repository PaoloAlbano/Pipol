/**
 * The version of the release an app build is for, or '' when it is not for a release (a preview of a branch, a build
 * of a developer). The version is the tag of the release, and a build from git does not know it by itself, so the
 * release tells it, in one of two ways:
 *
 *   1. APP_VERSION, when it builds the Docker image;
 *   2. the file `release-version.txt`, which the release writes in the branch that Cloudflare Pages builds for
 *      production (see docs/releasing.md). Every other branch has no such file, so its previews show no version.
 *
 * Whatever goes wrong (no file, a strange content) is no version: the build must never fail for this.
 */
import { readFileSync } from 'node:fs'

/** A version written as 1.2.3 (nothing else is taken for one), or ''. */
export function cleanVersion(text) {
  return /^\d+\.\d+\.\d+$/.test(text?.trim() ?? '') ? text.trim() : ''
}

/**
 * @param {{ env?: Record<string, string | undefined>, file?: string, readFile?: (file: string, encoding: string) => string }} [deps]
 *   `file`: where the release wrote the version (the root of the repository, which is where a build runs)
 */
export function resolveVersion({ env = process.env, file = 'release-version.txt', readFile = readFileSync } = {}) {
  if (cleanVersion(env.APP_VERSION)) return env.APP_VERSION.trim()
  try {
    return cleanVersion(readFile(file, 'utf8'))
  } catch {
    return ''
  }
}
