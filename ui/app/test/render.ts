// Loads a .tsx module through Vite's own API with no port (middleware mode, no HMR, no websocket).
// The tests call close() in after(). The Vite version is pinned; ssrLoadModule is its SSR loader.
import path from 'node:path'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer, type ViteDevServer } from 'vite'

export const uiDir = path.resolve(import.meta.dirname, '..', '..')
export const appDir = path.join(uiDir, 'app')

export type Renderer = {
  load<T = Record<string, any>>(file: string): Promise<T>
  render(el: ReactElement): string
  close(): Promise<void>
}

// `file` is relative to ui/app, e.g. 'components/ui/button.tsx'.
export async function createRenderer(): Promise<Renderer> {
  const server: ViteDevServer = await createServer({
    configFile: path.join(uiDir, 'vite.config.ts'),
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
    logLevel: 'error',
  })
  return {
    load: <T = Record<string, any>>(file: string) => server.ssrLoadModule(path.join(appDir, file)) as Promise<T>,
    render: (el) => renderToStaticMarkup(el),
    close: () => server.close(),
  }
}
