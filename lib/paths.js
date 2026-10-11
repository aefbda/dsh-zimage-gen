/**
 * 路径小工具（零依赖）。
 *
 * @module dsh-zimage-gen/paths
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 把 `~` 开头的路径展开为用户主目录。
 *
 * @param {string} filePath 可能含 `~` 的路径。
 * @returns {string} 展开后的路径（不含 `~` 时原样返回）。
 */
export function expandHome(filePath) {
  const value = String(filePath ?? '')
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}
