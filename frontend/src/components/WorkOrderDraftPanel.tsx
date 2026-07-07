import React, { useEffect, useState } from 'react';
import { listDrafts, getDraft, deleteDraft } from '../services/workOrderDrafts';

export default function WorkOrderDraftPanel({ onContinue }: { onContinue?: (payload: any) => void }) {
  const [drafts, setDrafts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await listDrafts();
      setDrafts(data || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleContinue = async (id: number) => {
    try {
      const draft = await getDraft(id);
      if (onContinue) onContinue(JSON.parse(draft.payload));
    } catch (e) {
      console.error(e);
      alert('No se pudo cargar el borrador');
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Eliminar borrador?')) return;
    try {
      await deleteDraft(id);
      await load();
    } catch (e) {
      console.error(e);
      alert('No se pudo eliminar el borrador');
    }
  };

  if (loading) return <div>Cargando borradores...</div>;
  if (!drafts || drafts.length === 0) return <div>No hay borradores</div>;

  return (
    <div>
      <h3>Borradores</h3>
      <ul>
        {drafts.map(d => (
          <li key={d.id} style={{ marginBottom: 8 }}>
            <strong>{d.title || 'Sin título'}</strong>
            <div style={{ fontSize: 12, color: '#666' }}>{new Date(d.updatedAt).toLocaleString()}</div>
            <div style={{ marginTop: 6 }}>
              <button onClick={() => handleContinue(d.id)} style={{ marginRight: 8 }}>Continuar</button>
              <button onClick={() => handleDelete(d.id)}>Eliminar</button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
