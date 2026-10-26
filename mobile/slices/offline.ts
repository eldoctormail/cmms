import type { PayloadAction } from '@reduxjs/toolkit';
import { createSlice } from '@reduxjs/toolkit';
import type { AppThunk } from '../store';
import WorkOrder from '../models/workOrder';
import { Page, SearchCriteria } from '../models/page';
import api from '../utils/api';
import { revertAll } from '../utils/redux';
import { cacheWorkOrderDetails } from './workOrder';
import { getTasks } from './task';
import { getLabors } from './labor';
import { getPartQuantitiesByWorkOrder } from './partQuantity';
import { getAdditionalCosts } from './additionalCost';
import { getRelations } from './relation';
import { getCommentsByWorkOrder } from './comment';

/** Maximum number of open work orders kept on the device for offline use. */
export const OFFLINE_WORK_ORDERS_LIMIT = 50;
/** Number of work orders whose details are downloaded in parallel. */
const DETAILS_CONCURRENCY = 3;

interface OfflineState {
  /** Open work orders assigned to the user, as of the last sync. */
  workOrders: WorkOrder[];
  /** ISO date of the last successful sync, null if never synced. */
  syncedAt: string | null;
}

const initialState: OfflineState = {
  workOrders: [],
  syncedAt: null
};

const slice = createSlice({
  name: 'offline',
  initialState,
  extraReducers: (builder) => builder.addCase(revertAll, () => initialState),
  reducers: {
    setOfflineWorkOrders(
      state: OfflineState,
      action: PayloadAction<{ workOrders: WorkOrder[]; syncedAt: string }>
    ) {
      state.workOrders = action.payload.workOrders;
      state.syncedAt = action.payload.syncedAt;
    }
  }
});

export const reducer = slice.reducer;

export const getOfflineCriteria = (): SearchCriteria => ({
  filterFields: [
    {
      field: 'status',
      operation: 'in',
      values: ['OPEN', 'IN_PROGRESS', 'ON_HOLD'],
      value: '',
      enumName: 'STATUS'
    },
    { field: 'archived', operation: 'eq', value: false },
    // Resolved server side to "assigned to me, primary worker or one of my
    // teams"; ignored for users who can only see their own work orders anyway.
    { field: 'assignedToUser', operation: 'eq', value: true }
  ],
  pageSize: OFFLINE_WORK_ORDERS_LIMIT,
  pageNum: 0,
  direction: 'DESC'
});

const runWithConcurrency = async <T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<unknown>
) => {
  const queue = [...items];
  const workers = Array.from(
    { length: Math.min(limit, queue.length) },
    async () => {
      while (queue.length) {
        await task(queue.shift());
      }
    }
  );
  await Promise.all(workers);
};

let syncInProgress: Promise<void> | null = null;

/**
 * Downloads the user's open work orders and everything the work order details
 * screen shows, so they can be browsed without connectivity. The data lands in
 * the regular slices (persisted with the rest of the store), so screens read it
 * the same way they read freshly fetched data.
 *
 * Concurrent calls share the sync already running.
 */
export const syncOfflineWorkOrders = (): AppThunk => (dispatch) => {
  if (!syncInProgress) {
    syncInProgress = (async () => {
      const page = await api.post<Page<WorkOrder>>(
        'work-orders/search',
        getOfflineCriteria()
      );
      const workOrders = page.content;
      dispatch(cacheWorkOrderDetails({ workOrders }));
      await runWithConcurrency(workOrders, DETAILS_CONCURRENCY, ({ id }) =>
        Promise.all([
          dispatch(getTasks(id)),
          dispatch(getLabors(id)),
          dispatch(getPartQuantitiesByWorkOrder(id)),
          dispatch(getAdditionalCosts(id)),
          dispatch(getRelations(id)),
          // The other detail thunks swallow their errors; this one rethrows.
          dispatch(getCommentsByWorkOrder(id)).catch(() => undefined)
        ])
      );
      dispatch(
        slice.actions.setOfflineWorkOrders({
          workOrders,
          syncedAt: new Date().toISOString()
        })
      );
    })().finally(() => {
      syncInProgress = null;
    });
  }
  return syncInProgress;
};

export default slice;
