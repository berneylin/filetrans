interface NamedSite {
  name: string
}

export function nextSiteName(sites: readonly NamedSite[]): string {
  const names = new Set(sites.map((site) => site.name))
  let name = '新站点'
  let index = 2
  while (names.has(name)) {
    name = `新站点 ${index}`
    index++
  }
  return name
}
