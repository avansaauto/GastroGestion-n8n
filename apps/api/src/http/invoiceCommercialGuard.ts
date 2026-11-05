export function unresolvedCommercialRelations<T extends { status: string }>(
  relations: T[],
): T[] {
  return relations.filter(
    (relation) => relation.status === 'proposed' || relation.status === 'requires_review',
  )
}

export function commercialRelationSaveBlockReason(
  relations: Array<{
    status: string
    type: 'bonus' | 'discount'
    targetLineId: string | null
    candidateTargetLineIds: string[]
  }>,
  lines: Array<{ id: string; name?: string | null; originalDescription?: string | null }>,
): string | null {
  const unresolved = unresolvedCommercialRelations(relations)
  if (unresolved.length === 0) return null
  const relation = unresolved[0]
  const kind = relation.type === 'discount' ? 'descuento' : 'bonificación'
  const target = lines.find((line) => line.id === relation.targetLineId)
    ?? lines.find((line) => relation.candidateTargetLineIds.includes(line.id))
  const name = target?.name?.trim() || target?.originalDescription?.trim()

  if (!relation.targetLineId && relation.candidateTargetLineIds.length > 1) {
    return name
      ? `Hay más de un producto candidato para la ${kind} de ${name}. Resolvela antes de guardar.`
      : `Hay una ${kind} con más de un producto candidato. Resolvela antes de guardar.`
  }
  if (!relation.targetLineId) {
    return `Hay una ${kind} sin producto asignado. Resolvela antes de guardar.`
  }
  return name
    ? `Confirmá o rechazá la ${kind} de ${name} antes de guardar.`
    : `Confirmá o rechazá la ${kind} pendiente antes de guardar.`
}
