// Browser stub for node-gyp-build.
// Native addons (.node files) cannot be loaded in a browser environment.
// Returning an empty object prevents "Cannot find addon" crashes.
// Packages that depend on specific native methods will fall back to
// their JS implementations (e.g. sodium-javascript for sodium-native).
export default function nativeLoader() {
  return {}
}
