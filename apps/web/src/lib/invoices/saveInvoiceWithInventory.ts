export async function saveInvoiceWithInventory<TSaved extends {
  idempotent?: boolean
  confirmIntentStored?: boolean
}>(input: {
  savedDocument: TSaved | null
  saveDraft: () => Promise<TSaved>
  confirm: (saved: TSaved) => Promise<void>
}): Promise<{ saved: TSaved; phase: 'already_registered' | 'confirmed' }> {
  const saved = input.savedDocument ?? await input.saveDraft()
  if (saved.idempotent && !saved.confirmIntentStored) {
    return { saved, phase: 'already_registered' }
  }
  await input.confirm(saved)
  return { saved, phase: 'confirmed' }
}
