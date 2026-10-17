// Every IPC call resolves to a Result. Errors carry a stable code and a
// human-readable message that never contains secret values.

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'FORBIDDEN'
  | 'INTERNAL'
  | 'FS_ERROR'
  | 'LOCKED'
  | 'NOT_CONFIGURED'
  | 'FOLDERS_OVERLAP'
  | 'PROJECTS_FOLDER_MISSING'
  | 'VAULT_FOLDER_MISSING'
  | 'VAULT_EXISTS'
  | 'VAULT_NOT_FOUND'
  | 'VAULT_META_MISSING'
  | 'META_INVALID'
  | 'PASSWORD_TOO_SHORT'
  | 'WRONG_PASSWORD'
  | 'KDF_FAILED'
  | 'VAULT_TAMPERED'
  | 'VAULT_ENTRY_NOT_FOUND'
  | 'VAULT_CHANGED'
  | 'LOCAL_CHANGED'
  | 'OVERWRITE_NOT_CONFIRMED'
  | 'REPO_NOT_FOUND'
  | 'ENV_NOT_FOUND'
  | 'ENV_SYMLINK'
  | 'ENV_NOT_FILE'
  | 'ENV_TOO_LARGE'
  | 'ENV_NOT_UTF8'
  | 'ENV_DUPLICATE_KEY'
  | 'ENV_NOT_IGNORED'
  | 'ENV_TRACKED'
  | 'BACKUP_NOT_IGNORED'
  | 'GITIGNORE_SYMLINK'
  | 'GIT_MISSING'
  | 'GIT_ERROR'

export interface AppErrorInfo {
  code: ErrorCode
  message: string
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppErrorInfo }
