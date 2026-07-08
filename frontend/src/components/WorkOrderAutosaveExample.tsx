import React, { useEffect, useRef, useState } from 'react';
import { saveDraft } from '../services/workOrderDrafts';

/**
 * Example integration component to demonstrate autosave of a Work Order draft.
 * - Debounces saves by 1s after user stops typing
 * - Does NOT include file inputs in the payload
 * - Keeps draftId in memory (you could persist in localStorage if desired)
 * - On final submit it calls the provided onSubmit and passes draftId so backend can delete the draft
 */
export default function WorkOrderAutosaveExample({
  initialValues = { title: '', description: '' },
  onSubmit,
}: {
  initialValues?: any;
  onSubmit: (formValues: any, draftId: number | null) => Promise<void>;
}) {
  const [form, setForm] = useState<any>(initialValues);
  const [draftId, setDraftId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    // cleanup on unmount
    return () => {
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const scheduleSave = () => {
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = window.setTimeout(() => {
      void doSave();
    }, 1000);
  };

  const doSave = async () => {
    setSaving(true);
    try {
      // Build payload excluding files (if you have files in form, exclude them here)
      const payload = {
        ...form,
      };
      const result = await saveDraft({ id: draftId ?? undefined, title: form.title, payload });
      if (result && result.id) setDraftId(result.id);
    } catch (err) {
      console.error('Failed to save draft', err);
    } finally {
      setSaving(false);
    }
  };

  const handleChange = (key: string, value: any) => {
    setForm((f: any) => ({ ...f, [key]: value }));
    scheduleSave();
  };

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    // Call provided onSubmit with draftId so backend can delete it after successful creation
    await onSubmit(form, draftId);
  };

  return (
    <form onSubmit={handleSubmit}>
      <div>
        <label>Title</label>
        <input
          type="text"
          value={form.title || ''}
          onChange={(e) => handleChange('title', e.target.value)}
        />
      </div>
      <div>
        <label>Description</label>
        <textarea
          value={form.description || ''}
          onChange={(e) => handleChange('description', e.target.value)}
        />
      </div>

      <div style={{ marginTop: 8 }}>
        <button type="submit">Guardar Work Order</button>
        <span style={{ marginLeft: 8 }}>{saving ? 'Guardando borrador...' : draftId ? `Borrador guardado (${draftId})` : 'Sin borrador'}</span>
      </div>
    </form>
  );
}
