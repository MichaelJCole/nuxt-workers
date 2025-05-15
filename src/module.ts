// src/module.ts
import { readFileSync } from 'node:fs'
import {
  defineNuxtModule,
  resolveFiles,
  updateTemplates,
  resolveAlias,
  addBuildPlugin,
} from '@nuxt/kit'
import { findExportNames } from 'mlly'
import { join, relative, resolve } from 'pathe'
import { withQuery } from 'ufo'
import type { InputPluginOption } from 'rollup'

import {
  VIRTUAL_ID,
  WorkerPlugin,
  WorkerTransformPlugin,
} from './plugins/unplugin'

export interface ModuleOptions {
  /**
   * Path to directories to be scanned for workers.
   * By default it is resolved relative to your `srcDir`
   */
  dir: string | string[]
}

console.log('[nuxt-workers] Module file loaded')

export default defineNuxtModule<ModuleOptions>({
  meta: {
    configKey: 'workers',
    name: 'nuxt-workers',
  },
  defaults: {
    dir: 'workers',
  },
  async setup(options, nuxt) {
    console.log('[nuxt-workers] Starting module setup') // Debug: Module initialization

    const scanPattern = nuxt.options.extensions.map(e => `*${e}`)
    console.log('[nuxt-workers] Scan pattern for worker files:', scanPattern) // Debug: File extensions

    const _dirs = new Set<string>()
    for (const dir of Array.isArray(options.dir)
      ? options.dir
      : [options.dir]) {
      for (const layer of nuxt.options._layers) {
        const resolvedDir = resolve(
          layer.config.srcDir || layer.cwd,
          resolveAlias(dir, nuxt.options.alias),
        )
        _dirs.add(resolvedDir)
      }
    }

    const dirs = Array.from(_dirs)
    console.log('[nuxt-workers] Directories to scan:', dirs) // Debug: Directories being scanned

    const context = {
      workerExports: Object.create(null) as Record<string, string>,
      reverseMap: Object.create(null) as Record<string, string[]>,
    }

    nuxt.hook('imports:extend', (i) => {
      console.log(
        '[nuxt-workers] Extending imports with worker exports:',
        context.workerExports,
      ) // Debug: Imports hook
      for (const name in context.workerExports) {
        i.push({
          name,
          from:
            VIRTUAL_ID + withQuery('', { source: context.workerExports[name] }),
        })
      }
    })

    console.log('[nuxt-workers] Adding client-side WorkerPlugin') // Debug: Plugin addition
    addBuildPlugin(
      WorkerPlugin({
        mode: 'client',
        sourcemap: !!nuxt.options.sourcemap.client,
        context,
      }),
      { server: false },
    )

    console.log('[nuxt-workers] Adding server-side WorkerPlugin') // Debug: Plugin addition
    addBuildPlugin(
      WorkerPlugin({
        mode: 'server',
        sourcemap: !!nuxt.options.sourcemap.server,
        context,
      }),
      { client: false },
    )

    const transformPlugin = WorkerTransformPlugin({
      mode: 'client',
      sourcemap: !!nuxt.options.sourcemap.client,
      context,
    })
    if (nuxt.options.dev) {
      console.log('[nuxt-workers] Adding transform plugin for development') // Debug: Dev mode plugin
      addBuildPlugin(transformPlugin, { server: false })
    }
    else {
      nuxt.hook('vite:extendConfig', (config, { isClient }) => {
        if (isClient) {
          console.log(
            '[nuxt-workers] Extending Vite config with transform plugin',
          ) // Debug: Vite config
          const plugins = (config.build!.rollupOptions!.plugins
            ||= []) as InputPluginOption[]
          plugins.push(transformPlugin.rollup())
        }
      })
    }

    const typesDir = join(nuxt.options.buildDir, 'types')
    nuxt.options.build.templates.unshift({
      filename: join(typesDir, 'nuxt-workers.d.ts'),
      write: true,
      async getContents() {
        console.log('[nuxt-workers] Generating worker type definitions') // Debug: Template generation start
        const files = await Promise.all(
          dirs.map(dir => resolveFiles(dir, scanPattern)),
        )
        const flattenedFiles = files.flat()
        console.log('[nuxt-workers] Found worker files:', flattenedFiles) // Debug: Files found

        let script
          = 'type ToAsyncFunction<T> = T extends (...args: infer A) => infer R ? (...args: A) => Promise<R> : T\n'
        script += 'export {}\n\n'
        script += 'declare global {\n'

        context.workerExports = Object.create(null)
        context.reverseMap = Object.create(null)
        for (const file of flattenedFiles) {
          const contents = readFileSync(file, 'utf-8')
          const exports = findExportNames(contents)
          console.log(`[nuxt-workers] Exports in ${file}:`, exports) // Debug: Exports per file
          for (const e of exports) {
            if (e in context.workerExports) {
              console.warn(
                `[nuxt-workers] Duplicate export \`${e}\` found in \`${file}\` and \`${context.workerExports[e]}\`.`,
              )
            }
            else {
              context.workerExports[e] = file
              context.reverseMap[file] ||= []
              context.reverseMap[file].push(e)
              script += `  const ${e}: ToAsyncFunction<typeof import(${JSON.stringify(
                relative(typesDir, file),
              )}).${e}>\n`
            }
          }
        }

        script += '}\n'
        console.log('[nuxt-workers] Type definitions generated') // Debug: Template generation end
        return script
      },
    })

    nuxt.hook('prepare:types', (ctx) => {
      console.log('[nuxt-workers] Adding type reference to nuxt-workers.d.ts') // Debug: Types hook
      ctx.references.push({ path: 'types/nuxt-workers.d.ts' })
    })

    nuxt.hook('builder:watch', (event, relativePath) => {
      const path = resolve(nuxt.options.srcDir, relativePath)
      if (!dirs.some(dir => path.startsWith(dir))) {
        return
      }
      console.log(
        '[nuxt-workers] Detected file change, updating templates:',
        path,
      ) // Debug: Watch hook
      return updateTemplates({
        filter(template) {
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
