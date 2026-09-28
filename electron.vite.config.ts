import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

const PRODUCTION_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'"

function productionCsp(): Plugin {
  return {
    name: 'filetrans-production-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const pattern = /(http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/
      if (!pattern.test(html)) throw new Error('index.html 中未找到 Content-Security-Policy')
      return html.replace(pattern, `$1${PRODUCTION_CSP}$2`)
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    plugins: [react(), tailwindcss(), productionCsp()]
  }
})
