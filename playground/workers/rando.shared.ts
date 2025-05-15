let rando = 0

export function sharedRandoHi() {
  if (!rando) rando = Math.random()
  return 'SHARED randoHi ' + rando
}
