// Importing necessary utilities from Node.js and Nuxt's kit for module development
import { readFileSync } from 'node:fs'
import {
  defineNuxtModule,
  resolveFiles,
  updateTemplates,
  resolveAlias,
  addBuildPlugin,
} from '@nuxt/kit'
// Utility to extract export names from worker files
import { findExportNames } from 'mlly'
// Path manipulation utilities
import { join, relative, resolve } from 'pathe'
// URL manipulation utility for adding query parameters
import { withQuery } from 'ufo'
// Type definition for Rollup plugins
import type { InputPluginOption } from 'rollup'

// Local imports for custom worker plugins
import {
  VIRTUAL_ID,
  WorkerPlugin,
  WorkerTransformPlugin,
} from './plugins/unplugin'

// Defines the configuration options for the module
export interface ModuleOptions {
  /**
   * Path to directories to be scanned for workers.
   * By default it is resolved relative to your `srcDir`
   */
  dir: string | string[]
}

// Debug log to confirm module file loading
console.log('[nuxt-workers] Module file loaded')

// Defines the Nuxt module with metadata and setup logic
export default defineNuxtModule<ModuleOptions>({
  meta: {
    configKey: 'workers', // Configuration key for the module in nuxt.config
    name: 'nuxt-workers', // Module name
  },
  defaults: {
    dir: 'worker', // Default directory to scan for worker files
  },
  async setup(options, nuxt) {
    // Logs the start of module setup for debugging
    console.log('[nuxt-workers] Starting module setup') // Debug: Module initialization

    // Creates a scan pattern based on Nuxt's configured file extensions (e.g., *.ts, *.js)
    const scanPattern = nuxt.options.extensions.map(e => `*${e}`)
    console.log('[nuxt-workers] Scan pattern for worker files:', scanPattern) // Debug: File extensions

    // Resolves unique directories to scan, considering Nuxt layers and aliases
    const _dirs = new Set<string>()
    for (const dir of Array.isArray(options.dir)
      ? options.dir
      : [options.dir]) {
      for (const layer of nuxt.options._layers) {
        const resolvedDir = resolve(
          layer.config.srcDir || layer.cwd, // Base directory from layer config
          resolveAlias(dir, nuxt.options.alias), // Resolves aliases in the path
        )
        _dirs.add(resolvedDir)
      }
    }
    const dirs = Array.from(_dirs)
    console.log('[nuxt-workers] Directories to scan:', dirs) // Debug: Directories being scanned

    // Context object to store worker exports and reverse mapping from files to exports
    const context = {
      workerExports: Object.create(null) as Record<string, string>,
      reverseMap: Object.create(null) as Record<string, string[]>,
    }

    // Extends Nuxt's auto-imports with worker exports
    nuxt.hook('imports:extend', (i) => {
      console.log(
        '[nuxt-workers] Extending imports with worker exports:',
        context.workerExports,
      ) // Debug: Imports hook
      for (const name in context.workerExports) {
        i.push({
          name, // Export name from worker file
          from:
            VIRTUAL_ID + withQuery('', { source: context.workerExports[name] }), // Virtual ID with source file query
        })
      }
    })

    // Adds client-side WorkerPlugin for processing worker files
    console.log('[nuxt-workers] Adding client-side WorkerPlugin') // Debug: Plugin addition
    addBuildPlugin(
      WorkerPlugin({
        mode: 'client', // Targets client-side environment
        sourcemap: !!nuxt.options.sourcemap.client, // Enables sourcemaps if configured
        context, // Passes shared context
      }),
      { server: false }, // Excludes from server build
    )

    // Adds server-side WorkerPlugin for processing worker files
    console.log('[nuxt-workers] Adding server-side WorkerPlugin') // Debug: Plugin addition
    addBuildPlugin(
      WorkerPlugin({
        mode: 'server', // Targets server-side environment
        sourcemap: !!nuxt.options.sourcemap.server, // Enables sourcemaps if configured
        context, // Passes shared context
      }),
      { client: false }, // Excludes from client build
    )

    // Configures the transform plugin for client-side worker processing
    const transformPlugin = WorkerTransformPlugin({
      mode: 'client', // Targets client-side environment
      sourcemap: !!nuxt.options.sourcemap.client, // Enables sourcemaps if configured
      context, // Passes shared context
    })
    if (nuxt.options.dev) {
      // Adds transform plugin in development mode
      console.log('[nuxt-workers] Adding transform plugin for development') // Debug: Dev mode plugin
      addBuildPlugin(transformPlugin, { server: false }) // Excludes from server build
    }
    else {
      // Extends Vite config in production to include transform plugin
      nuxt.hook('vite:extendConfig', (config, { isClient }) => {
        if (isClient) {
          console.log(
            '[nuxt-workers] Extending Vite config with transform plugin',
          ) // Debug: Vite config
          const plugins = (config.build!.rollupOptions!.plugins
            ||= []) as InputPluginOption[]
          plugins.push(transformPlugin.rollup()) // Adds plugin to Rollup options
        }
      })
    }

    // Sets up type definitions generation for worker exports
    const typesDir = join(nuxt.options.buildDir, 'types')
    nuxt.options.build.templates.unshift({
      filename: join(typesDir, 'nuxt-workers.d.ts'), // Output file for type definitions
      write: true, // Ensures the file is written to disk
      async getContents() {
        // Logs the start of type definition generation
        console.log('[nuxt-workers] Generating worker type definitions') // Debug: Template generation start
        const files = await Promise.all(
          dirs.map(dir => resolveFiles(dir, scanPattern)), // Scans directories for worker files
        )
        const flattenedFiles = files.flat()
        console.log('[nuxt-workers] Found worker files:', flattenedFiles) // Debug: Files found

        // Generates TypeScript declarations for worker exports
        let script
          = 'type ToAsyncFunction<T> = T extends (...args: infer A) => infer R ? (...args: A) => Promise<R> : T\n' // Utility type for async functions
        script += 'export {}\n\n' // Empty export to satisfy module syntax
        script += 'declare global {\n' // Declares exports as global variables

        context.workerExports = Object.create(null) // Resets worker exports
        context.reverseMap = Object.create(null) // Resets reverse mapping
        for (const file of flattenedFiles) {
          const contents = readFileSync(file, 'utf-8') // Reads worker file contents
          const exports = findExportNames(contents) // Extracts export names
          console.log(`[nuxt-workers] Exports in ${file}:`, exports) // Debug: Exports per file
          for (const e of exports) {
            if (e in context.workerExports) {
              // Warns about duplicate exports across files
              console.warn(
                `[nuxt-workers] Duplicate export \`${e}\` found in \`${file}\` and \`${context.workerExports[e]}\`.`,
              )
            }
            else {
              context.workerExports[e] = file // Maps export to its source file
              context.reverseMap[file] ||= [] // Initializes reverse map array
              context.reverseMap[file].push(e) // Adds export to reverse map
              script += `  const ${e}: ToAsyncFunction<typeof import(${JSON.stringify(
                relative(typesDir, file),
              )}).${e}>\n` // Declares export as async function
            }
          }
        }

        script += '}\n' // Closes global declaration block
        console.log('[nuxt-workers] Type definitions generated') // Debug: Template generation end
        return script // Returns generated type definitions
      },
    })

    // Adds reference to generated type definitions in Nuxt's type checking
    nuxt.hook('prepare:types', (ctx) => {
      console.log('[nuxt-workers] Adding type reference to nuxt-workers.d.ts') // Debug: Types hook
      ctx.references.push({ path: 'types/nuxt-workers.d.ts' }) // Includes type file
    })

    // Watches for changes in worker directories and updates templates
    nuxt.hook('builder:watch', (event, relativePath) => {
      const path = resolve(nuxt.options.srcDir, relativePath) // Resolves changed file path
      if (!dirs.some(dir => path.startsWith(dir))) {
        return // Ignores changes outside worker directories
      }
      console.log(
        '[nuxt-workers] Detected file change, updating templates:',
        path,
      ) // Debug: Watch hook
      return updateTemplates({
        filter(template) {
          // Filters templates to update (type definitions and imports)
          return (
            template.filename.endsWith('nuxt-workers.d.ts')
            || ['/types/imports.d.ts', '/imports.d.ts', '/imports.mjs'].some(i =>
              template.filename.endsWith(i),
            )
          )
        },
      })
    })
  },
})
