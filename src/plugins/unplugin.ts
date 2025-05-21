// Importing utilities essential for worker plugin functionality within Nuxt's ecosystem
import { findExports } from 'mlly' // Used to extract export names from worker files during build
import { parseQuery } from 'ufo' // Parses virtual module query parameters, critical for runtime resolution
import { createUnplugin } from 'unplugin' // Framework-agnostic plugin creator, integrates with Nuxt's Vite/Webpack build
import MagicString from 'magic-string' // Enables precise code transformations during Nuxt's build process

// Defines the virtual module ID for worker imports, a key identifier in Nuxt's module resolution
export const VIRTUAL_ID = 'virtual:nuxt-workers.mjs'

// Interface defining options for worker plugins, shared across build and runtime phases
interface WorkerPluginOptions {
  mode: 'server' | 'client' // Determines execution context (SSR vs CSR) in Nuxt
  context: {
    workerExports: Record<string, string> // Maps exports to source files, built during Nuxt's setup
    reverseMap: Record<string, string[]> // Maps files to export names, used in dev and build
  }
  sourcemap?: boolean // Optional flag for sourcemaps, useful in Nuxt dev mode
}

// --- Section: WorkerTransformPlugin Definition ---
// This plugin transforms worker files during Nuxt's build phase, targeting client-side execution.
// It integrates with Nuxt's Vite/Webpack pipeline to modify worker code for message passing.

/**
 * Transforms worker files by appending message handling logic for client-side execution in Nuxt.
 * Runs during the build phase to prepare workers for runtime communication with the main thread.
 */
export const WorkerTransformPlugin = (opts: WorkerPluginOptions) =>
  createUnplugin(() => {
    return {
      name: 'nuxt-workers:transform', // Identifies the plugin in Nuxt's build logs
      enforce: 'pre', // Ensures transformation happens early in Nuxt's build pipeline
      transform(code, _id) {
        // Skip transformation in server mode (SSR), as workers are client-only in Nuxt
        if (opts.mode === 'server') return

        // Clean ID by removing query params, aligning with Nuxt's file resolution
        const id = _id.replace(/\?.+$/, '')
        // Skip if the file isn’t a registered worker, leveraging context built in Nuxt setup
        if (!(id in opts.context.reverseMap)) return

        // Detect SharedWorker files, a distinction relevant for Nuxt's runtime behavior
        const isShared = id.endsWith('.shared.ts')
        const s = new MagicString(code) // Transform code efficiently during Nuxt build

        // Remove 'export' keywords to adapt code for worker environments
        const vals = findExports(code)
        for (const val of vals) {
          s.replace(val.code, val.code.replace(/export /g, ''))
        }

        // Construct export object from context, used at runtime by worker logic
        const exports = opts.context.reverseMap[id]
        const workerExports = `__worker_exports__ = { ${exports
          .map(e => `${e}: ${e}`)
          .join(', ')} }`

        if (isShared) {
          // Append SharedWorker logic for Nuxt's client-side runtime
          s.append(
            [
              '',
              `const ${workerExports};`, // Defines exports for runtime access
              `self.onconnect = function(e) {`, // Handles connections in dev and prod
              `  const port = e.ports[0];`,
              `  console.log("[SharedWorker] Connected:", port);`, // Debug log for Nuxt dev
              `  port.onmessage = async function(event) {`, // Message handler for runtime
              `    console.log("[SharedWorker] Message received:", event.data);`, // Debug log
              `    const { name, args, id } = event.data;`, // Parse message at runtime
              `    const fn = __worker_exports__[name];`,
              `    if (!fn) {`,
              `      port.postMessage({ error: "Function not found: " + name, id });`, // Error handling
              `      return;`,
              `    }`,
              `    try {`,
              `      const result = await fn(...args);`, // Execute function asynchronously
              `      port.postMessage({ result, id });`, // Send result back to main thread
              `    } catch (e) {`,
              `      port.postMessage({ error: e.message, id });`, // Handle runtime errors
              `    }`,
              `  };`,
              `  port.start();`, // Explicitly start port, required for SharedWorker runtime
              `};`,
            ].join('\n'),
          )
        }
        else {
          // Append regular Worker logic for Nuxt's client-side runtime
          s.append(
            [
              '',
              `const ${workerExports};`, // Defines exports for runtime access
              `self.onmessage = async (e) => {`, // Message handler for runtime
              `  console.log("[Worker] Message received:", e.data);`, // Debug log for Nuxt dev
              `  const { name, args, id } = event.data;`, // Parse message at runtime
              `  const fn = __worker_exports__[name];`,
              `  if (!fn) {`,
              `    self.postMessage({ error: "Function not found: " + name, id });`, // Error handling
              `      return;`,
              `    }`,
              `    try {`,
              `      const result = await fn(...args);`, // Execute function asynchronously
              `      self.postMessage({ result, id });`, // Send result back to main thread
              `    } catch (e) {`,
              `      self.postMessage({ error: e.message, id });`, // Handle runtime errors
              `    }`,
              `  };`,
            ].join('\n'),
          )
        }

        // Return transformed code, with sourcemaps for Nuxt dev if enabled
        return {
          code: s.toString(),
          map: opts?.sourcemap ? s.generateMap({ hires: true }) : null,
        }
      },
    }
  })

// --- Section: WorkerPlugin Definition ---
// This plugin generates virtual modules during Nuxt's build, enabling worker imports.
// It supports both client-side (runtime) and server-side (SSR) contexts in Nuxt.

/**
 * Generates the virtual module for worker imports, bridging build and runtime in Nuxt.
 * Provides client-side worker initialization or server-side direct imports based on mode.
 */
export const WorkerPlugin = (opts: WorkerPluginOptions) =>
  createUnplugin(() => {
    return {
      name: 'nuxt-workers:load', // Identifies the plugin in Nuxt's build logs
      enforce: 'pre', // Runs early to resolve virtual modules in Nuxt’s build
      resolveId(id) {
        // Resolve virtual module IDs during Nuxt’s build and dev server
        if (id.startsWith(VIRTUAL_ID)) return id
      },
      loadInclude: id => id.startsWith(VIRTUAL_ID), // Filter for virtual modules in build
      load(id) {
        // Parse query to get source file, used in Nuxt’s runtime module resolution
        const query = parseQuery(id.split('?')[1])
        const file = query.source as string
        const exports = opts.context.reverseMap[file]
        if (!exports || !exports.length) return 'export {}' // Empty export for invalid cases

        let source = '' // Build source code for the virtual module
        if (opts.mode === 'client') {
          // Client-side logic for Nuxt’s runtime environment
          const isShared = file.endsWith('.shared.ts')
          const workerType = isShared ? 'SharedWorker' : 'Worker'
          source += `
const map = {}; // Tracks promises in runtime
let count = 0; // Unique IDs for messages
let _nuxt_worker; // Worker instance for runtime reuse

function initWorker() {
  // Initialize worker during Nuxt runtime, using module type for ES modules
  const worker = new ${workerType}(new URL(${JSON.stringify(
    file,
  )}, import.meta.url), { type: "module" });
  console.log("[${workerType}] Initialized for ${file}"); // Debug log for Nuxt dev
  ${
    isShared
      ? `
  worker.port.onmessage = (e) => { // Handle runtime messages
    const [resolve, reject] = map[e.data.id];
    if ("error" in e.data) {
      reject(new Error(e.data.error)); // Reject promise on error
    } else {
      resolve(e.data.result); // Resolve promise with result
    }
  };
  worker.port.start(); // Start port for SharedWorker runtime
  `
      : `
  worker.onmessage = (e) => { // Handle runtime messages
    const [resolve, reject] = map[e.data.id];
    if ("error" in e.data) {
      reject(new Error(e.data.error)); // Reject promise on error
    } else {
      resolve(e.data.result); // Resolve promise with result
    }
  };
  `
  }
  return worker;
}
`
        }

        // Generate export functions for each worker export
        for (const name of exports) {
          source += `\nexport async function ${name} (...args) {`
          if (opts.mode === 'server') {
            // Server-side logic for Nuxt SSR, executed during build and runtime
            source += `
  const { ${name}: fn } = await import(${JSON.stringify(
    file,
  )}); // Dynamic import for SSR
  return fn(...args); // Direct call in server context
`
          }
          else {
            // Client-side logic for Nuxt runtime
            const isShared = file.endsWith('.shared.ts')
            const postMessageTarget = isShared
              ? '_nuxt_worker.port' // SharedWorker runtime target
              : '_nuxt_worker' // Regular Worker runtime target
            source += `
  _nuxt_worker ||= initWorker(); // Lazy init during runtime
  const id = count++; // Unique message ID
  return new Promise((resolve, reject) => {
    map[id] = [resolve, reject]; // Store promise handlers
    ${postMessageTarget}.postMessage({ name: ${JSON.stringify(
      name,
    )}, args, id }); // Send message at runtime
  });
`
          }
          source += `}\n`
        }

        // Return generated code for Nuxt’s virtual module system
        return { code: source, map: null }
      },
    }
  })
