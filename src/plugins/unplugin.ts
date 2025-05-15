// src/plugins/unplugin.ts
import { findExports } from 'mlly'
import { parseQuery } from 'ufo'
import { createUnplugin } from 'unplugin'
import MagicString from 'magic-string'

export const VIRTUAL_ID = 'virtual:nuxt-workers.mjs'

interface WorkerPluginOptions {
  mode: 'server' | 'client'
  context: {
    workerExports: Record<string, string>
    reverseMap: Record<string, string[]>
  }
  sourcemap?: boolean
}

/**
 * Transforms worker files by appending message handling logic.
 */
export const WorkerTransformPlugin = (opts: WorkerPluginOptions) =>
  createUnplugin(() => {
    return {
      name: 'nuxt-workers:transform',
      enforce: 'pre',
      transform(code, _id) {
        if (opts.mode === 'server') return

        const id = _id.replace(/\?.+$/, '')
        if (!(id in opts.context.reverseMap)) return

        const isShared = id.endsWith('.shared.ts')
        const s = new MagicString(code)

        // Remove 'export' keywords from the worker code
        const vals = findExports(code)
        for (const val of vals) {
          s.replace(val.code, val.code.replace(/export /g, ''))
        }

        const exports = opts.context.reverseMap[id]
        const workerExports = `__worker_exports__ = { ${exports
          .map(e => `${e}: ${e}`)
          .join(', ')} }`

        if (isShared) {
          // Simple Shared Worker implementation
          s.append(
            [
              '',
              `const ${workerExports};`,
              `self.onconnect = function(e) {`,
              `  const port = e.ports[0];`,
              `  console.log("[SharedWorker] Connected:", port);`, // Debug log
              `  port.onmessage = async function(event) {`,
              `    console.log("[SharedWorker] Message received:", event.data);`, // Debug log
              `    const { name, args, id } = event.data;`,
              `    const fn = __worker_exports__[name];`,
              `    if (!fn) {`,
              `      port.postMessage({ error: "Function not found: " + name, id });`,
              `      return;`,
              `    }`,
              `    try {`,
              `      const result = await fn(...args);`,
              `      port.postMessage({ result, id });`,
              `    } catch (e) {`,
              `      port.postMessage({ error: e.message, id });`,
              `    }`,
              `  };`,
              `  port.start();`, // Explicitly start the port
              `};`,
            ].join('\n'),
          )
        }
        else {
          // Regular Worker implementation
          s.append(
            [
              '',
              `const ${workerExports};`,
              `self.onmessage = async (e) => {`,
              `  console.log("[Worker] Message received:", e.data);`, // Debug log
              `  const { name, args, id } = e.data;`,
              `  const fn = __worker_exports__[name];`,
              `  if (!fn) {`,
              `    self.postMessage({ error: "Function not found: " + name, id });`,
              `    return;`,
              `  }`,
              `  try {`,
              `    const result = await fn(...args);`,
              `    self.postMessage({ result, id });`,
              `  } catch (e) {`,
              `    self.postMessage({ error: e.message, id });`,
              `  }`,
              `};`,
            ].join('\n'),
          )
        }

        return {
          code: s.toString(),
          map: opts?.sourcemap ? s.generateMap({ hires: true }) : null,
        }
      },
    }
  })

/**
 * Generates the virtual module for worker imports.
 */
export const WorkerPlugin = (opts: WorkerPluginOptions) =>
  createUnplugin(() => {
    return {
      name: 'nuxt-workers:load',
      enforce: 'pre',
      resolveId(id) {
        if (id.startsWith(VIRTUAL_ID)) return id
      },
      loadInclude: id => id.startsWith(VIRTUAL_ID),
      load(id) {
        const query = parseQuery(id.split('?')[1])
        const file = query.source as string
        const exports = opts.context.reverseMap[file]
        if (!exports || !exports.length) return 'export {}'

        let source = ''
        if (opts.mode === 'client') {
          const isShared = file.endsWith('.shared.ts')
          const workerType = isShared ? 'SharedWorker' : 'Worker'
          source += `
const map = {};
let count = 0;
let _nuxt_worker;

function initWorker() {
  const worker = new ${workerType}(new URL(${JSON.stringify(
    file,
  )}, import.meta.url), { type: "module" });
  console.log("[${workerType}] Initialized for ${file}"); // Debug log
  ${
    isShared
      ? `
  worker.port.onmessage = (e) => {
    const [resolve, reject] = map[e.data.id];
    if ("error" in e.data) {
      reject(new Error(e.data.error));
    } else {
      resolve(e.data.result);
    }
  };
  worker.port.start(); // Start the port explicitly
  `
      : `
  worker.onmessage = (e) => {
    const [resolve, reject] = map[e.data.id];
    if ("error" in e.data) {
      reject(new Error(e.data.error));
    } else {
      resolve(e.data.result);
    }
  };
  `
  }
  return worker;
}
`
        }

        for (const name of exports) {
          source += `\nexport async function ${name} (...args) {`
          if (opts.mode === 'server') {
            source += `
  const { ${name}: fn } = await import(${JSON.stringify(file)});
  return fn(...args);
`
          }
          else {
            const isShared = file.endsWith('.shared.ts')
            const postMessageTarget = isShared
              ? '_nuxt_worker.port'
              : '_nuxt_worker'
            source += `
  _nuxt_worker ||= initWorker();
  const id = count++;
  return new Promise((resolve, reject) => {
    map[id] = [resolve, reject];
    ${postMessageTarget}.postMessage({ name: ${JSON.stringify(
      name,
    )}, args, id });
  });
`
          }
          source += `}\n`
        }

        return { code: source, map: null }
      },
    }
  })
