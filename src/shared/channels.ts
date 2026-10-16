// IPC channel names. Kept free of runtime dependencies so the sandboxed
// preload can import it without bundling zod.

export const CH = {
  ping: 'app:ping'
} as const

export type Channel = (typeof CH)[keyof typeof CH]

// Events pushed from main to the renderer.
export const EV = {} as const
