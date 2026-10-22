// The icon for each row action, shared by the repo table and mini mode.
import { Download, GitCompareArrows, GitMerge, Upload, type LucideIcon } from 'lucide-vue-next'
import type { RowAction } from './status'

export const ACTION_ICON: Record<RowAction, LucideIcon> = {
  push: Upload,
  pull: Download,
  merge: GitMerge,
  resolve: GitCompareArrows,
  'keep-local': Upload,
  'keep-vault': Download
}
