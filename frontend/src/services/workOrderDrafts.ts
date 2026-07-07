const base = '/work-order-drafts';

export async function saveDraft(draft: { id?: number; title?: string; payload: any }) {
  const res = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  });
  if (!res.ok) throw new Error('Failed to save draft');
  return res.json();
}

export async function listDrafts() {
  const res = await fetch(base);
  if (!res.ok) throw new Error('Failed to list drafts');
  return res.json();
}

export async function getDraft(id: number) {
  const res = await fetch(`${base}/${id}`);
  if (!res.ok) throw new Error('Failed to get draft');
  return res.json();
}

export async function deleteDraft(id: number) {
  const res = await fetch(`${base}/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete draft');
}
