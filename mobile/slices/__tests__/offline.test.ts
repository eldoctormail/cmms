import { combineReducers, configureStore } from '@reduxjs/toolkit';
import api from '../../utils/api';
import { revertAll } from '../../utils/redux';
import {
  OFFLINE_WORK_ORDERS_LIMIT,
  reducer as offlineReducer,
  syncOfflineWorkOrders
} from '../offline';
import { reducer as workOrderReducer } from '../workOrder';
import { reducer as taskReducer } from '../task';
import { reducer as laborReducer } from '../labor';
import { reducer as partQuantityReducer } from '../partQuantity';
import { reducer as additionalCostReducer } from '../additionalCost';
import { reducer as relationReducer } from '../relation';
import { reducer as commentReducer } from '../comment';

jest.mock('../../utils/api', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    deletes: jest.fn()
  }
}));

const mockedApi = api as jest.Mocked<typeof api>;

const makeStore = () =>
  configureStore({
    reducer: combineReducers({
      offline: offlineReducer,
      workOrders: workOrderReducer,
      tasks: taskReducer,
      labors: laborReducer,
      partQuantities: partQuantityReducer,
      additionalCosts: additionalCostReducer,
      relations: relationReducer,
      comments: commentReducer
    }),
    middleware: (getDefault) => getDefault({ serializableCheck: false })
  });

const workOrders = [
  { id: 1, title: 'Chiller' },
  { id: 2, title: 'Generator' }
];

const mockServer = (failComments = false) => {
  mockedApi.post.mockImplementation(async (url: string) => {
    if (url === 'work-orders/search') return { content: workOrders };
    if (url.startsWith('comments/search/')) {
      if (failComments) throw new Error('boom');
      return [{ id: 99, content: 'hello' }];
    }
    throw new Error(`unexpected POST ${url}`);
  });
  mockedApi.get.mockImplementation(async (url: string) => {
    const id = Number(url.split('/').pop());
    if (url.startsWith('tasks/work-order/')) return [{ id: id * 10 }];
    return [];
  });
};

describe('syncOfflineWorkOrders', () => {
  beforeEach(() => jest.clearAllMocks());

  it('requests open, unarchived work orders assigned to the user', async () => {
    mockServer();
    await makeStore().dispatch(syncOfflineWorkOrders());

    const [url, criteria] = mockedApi.post.mock.calls[0];
    expect(url).toBe('work-orders/search');
    expect(criteria).toMatchObject({ pageSize: OFFLINE_WORK_ORDERS_LIMIT });
    const fields = Object.fromEntries(
      criteria.filterFields.map((f) => [f.field, f])
    );
    expect(fields.status.values).toEqual(['OPEN', 'IN_PROGRESS', 'ON_HOLD']);
    expect(fields.archived.value).toBe(false);
    expect(fields.assignedToUser).toBeDefined();
  });

  it('stores the work orders and the details the details screen reads', async () => {
    mockServer();
    const store = makeStore();
    await store.dispatch(syncOfflineWorkOrders());
    const state = store.getState();

    expect(state.offline.workOrders).toEqual(workOrders);
    expect(state.offline.syncedAt).not.toBeNull();
    expect(state.workOrders.workOrderInfos[2].workOrder).toEqual(workOrders[1]);
    expect(state.tasks.tasksByWorkOrder[1]).toEqual([{ id: 10 }]);
    expect(state.comments.commentsByWorkOrder[2]).toHaveLength(1);
    expect(state.tasks.loadingTasks[1]).toBe(false);
  });

  it('completes even if one of the detail requests fails', async () => {
    mockServer(true);
    const store = makeStore();
    await store.dispatch(syncOfflineWorkOrders());
    expect(store.getState().offline.workOrders).toHaveLength(2);
  });

  it('keeps the previous data when the server is unreachable', async () => {
    mockServer();
    const store = makeStore();
    await store.dispatch(syncOfflineWorkOrders());
    const { syncedAt } = store.getState().offline;

    mockedApi.post.mockRejectedValueOnce(
      new TypeError('Network request failed')
    );
    await expect(store.dispatch(syncOfflineWorkOrders())).rejects.toThrow();
    expect(store.getState().offline).toEqual({ workOrders, syncedAt });
  });

  it('shares a sync already in progress', async () => {
    mockServer();
    const store = makeStore();
    await Promise.all([
      store.dispatch(syncOfflineWorkOrders()),
      store.dispatch(syncOfflineWorkOrders())
    ]);
    const searches = mockedApi.post.mock.calls.filter(
      ([url]) => url === 'work-orders/search'
    );
    expect(searches).toHaveLength(1);
  });

  it('is cleared on logout', async () => {
    mockServer();
    const store = makeStore();
    await store.dispatch(syncOfflineWorkOrders());
    store.dispatch(revertAll());
    expect(store.getState().offline).toEqual({
      workOrders: [],
      syncedAt: null
    });
  });
});
