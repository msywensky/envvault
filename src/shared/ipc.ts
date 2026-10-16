// Request schemas for every channel. Imported by main only; the renderer and
// preload use `import type` so zod is never bundled into them.
import { z } from 'zod'
import { CH } from './channels'

const NoArgs = z.undefined()

export const requestSchemas = {
  [CH.ping]: NoArgs
} as const
