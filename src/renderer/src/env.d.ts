/// <reference types="vite/client" />
import type { FileTransApi } from '@shared/api'

declare global {
  interface Window {
    api: FileTransApi
  }
}

export {}
