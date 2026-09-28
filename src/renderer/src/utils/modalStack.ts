const stack: symbol[] = []

export function pushModal(): symbol {
  const token = Symbol('modal')
  stack.push(token)
  return token
}

export function popModal(token: symbol): void {
  const index = stack.lastIndexOf(token)
  if (index >= 0) stack.splice(index, 1)
}

export function isTopModal(token: symbol): boolean {
  return stack[stack.length - 1] === token
}
