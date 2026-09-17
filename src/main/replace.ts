import { randomUUID } from 'node:crypto'

interface ReplaceOperations {
  rename: (source: string, target: string) => Promise<void>
  replace?: (source: string, target: string) => Promise<void>
  exists: (target: string) => Promise<boolean>
  remove: (target: string) => Promise<void>
}

export async function replaceWithRollback(
  source: string,
  target: string,
  operations: ReplaceOperations
): Promise<void> {
  try {
    await (operations.replace ?? operations.rename)(source, target)
    return
  } catch (error) {
    if (!(await operations.exists(target))) throw error
  }

  const backup = `${target}.filetrans-backup-${randomUUID()}`
  await operations.rename(target, backup)
  try {
    await operations.rename(source, target)
  } catch (error) {
    try {
      await operations.rename(backup, target)
    } catch {
      throw new Error(`替换失败且无法恢复原目标，原内容保存在: ${backup}`, { cause: error })
    }
    throw error
  }
  await operations.remove(backup).catch(() => undefined)
}
