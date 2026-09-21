export function parseBannedDirs(input: string): string[] {
  return input
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

export function pickSyncPath(panePath: string, selectedDirs: string[], remembered: string): string {
  if (selectedDirs.length === 1) return selectedDirs[0]
  if (remembered) return remembered
  return panePath
}
