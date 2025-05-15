let rando = 0

export function randoHi() {
  if (!rando) rando = Math.random()
  return 'randoHi ' + rando
}
