import { combineReducers, configureStore } from '@reduxjs/toolkit';
import api from '../../utils/api';
import { revertAll } from '../../utils/redux';
import {
  discardEntry,
  mergePendingComments,
  mergePendingLabors,
  mergePendingTasks,
  processOutbox,
  reducer as outboxReducer,
  retryEntry,
  submitOperation
} from '../outbox';
import { reducer as taskReducer } from '../task';
import { reducer as commentReducer } from '../comment';
import { reducer as laborReducer } from '../labor';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('../../config', () => ({ getApiUrl: async () => 'https://x/' }));

jest.mock('../../utils/api', () => {
  const actual = jest.requireActual('../../utils/api');
  return {
    __esModule: true,
    isNetworkError: actual.isNetworkError,
    default: {
      get: jest.fn(),
      post: jest.fn(),
      patch: jest.fn(),
      deletes: jest.fn()
    }
  };
});

const mockedApi = api as jest.Mocked<typeof api>;

const makeStore = () =>
  configureStore({
    reducer: combineReducers({
      outbox: outboxReducer,
      tasks: taskReducer,
      comments: commentReducer,
      labors: laborReducer
    }),
    middleware: (getDefault) => getDefault({ serializableCheck: false })
  });

const networkError = () => new TypeError('Network request failed');
const httpError = (status: number, message = 'nope') => {
  const error = new Error(JSON.stringify({ message }));
  (error as any).status = status;
  return error;
};

const task = (id: number, value?: string) =>
  ({
    id,
    value,
    notes: '',
    taskBase: { id, label: `t${id}` },
    images: []
  } as any);

const patchTaskOp = (taskId: number, value: string) => ({
  type: 'PATCH_TASK' as const,
  workOrderId: 1,
  taskId,
  body: task(taskId, value)
});

const commentOp = (content: string) => ({
  type: 'CREATE_COMMENT' as const,
  workOrderId: 1,
  body: { workOrder: { id: 1 }, content, files: [] },
  author: { id: 7, firstName: 'Ana', lastName: 'Diaz' } as any
});

describe('outbox', () => {
  beforeEach(() => jest.resetAllMocks());

  it('sends right away when online and updates the slice', async () => {
    mockedApi.patch.mockImplementation(async (_url, body: any) => body);
    const store = makeStore();
    store.dispatch({
      type: 'tasks/getTasks',
      payload: { id: 1, tasks: [task(10, 'OPEN')] }
    });

    await expect(
      store.dispatch(submitOperation(patchTaskOp(10, 'COMPLETE')))
    ).resolves.toBe('sent');

    expect(store.getState().outbox.entries).toHaveLength(0);
    expect(store.getState().tasks.tasksByWorkOrder[1][0].value).toBe(
      'COMPLETE'
    );
    const [url, , options] = mockedApi.patch.mock.calls[0];
    expect(url).toBe('tasks/10');
    expect((options as any).idempotencyKey).toEqual(expect.any(String));
  });

  it('queues the change without connectivity and sends it later in order', async () => {
    mockedApi.post.mockRejectedValue(networkError());
    const store = makeStore();

    await expect(
      store.dispatch(submitOperation(commentOp('first')))
    ).resolves.toBe('queued');
    await store.dispatch(submitOperation(commentOp('second')));
    expect(store.getState().outbox.entries).toHaveLength(2);

    let nextId = 100;
    mockedApi.post.mockReset();
    mockedApi.post.mockImplementation(async (_url, body: any) => ({
      id: nextId++,
      content: body.content
    }));
    await store.dispatch(processOutbox());

    expect(store.getState().outbox.entries).toHaveLength(0);
    expect(
      mockedApi.post.mock.calls.map(([, body]: any) => body.content)
    ).toEqual(['first', 'second']);
  });

  it('reuses the same idempotency key when retrying an entry', async () => {
    mockedApi.post.mockRejectedValue(networkError());
    const store = makeStore();
    await store.dispatch(submitOperation(commentOp('hello')));
    await store.dispatch(processOutbox());

    const keys = mockedApi.post.mock.calls.map(
      ([, , o]: any) => o.idempotencyKey
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('folds changes to the same task that were not attempted yet', async () => {
    const store = makeStore();
    // A failing entry ahead in the queue blocks the following ones.
    mockedApi.post.mockRejectedValue(networkError());
    await store.dispatch(submitOperation(commentOp('blocker')));
    await store.dispatch(submitOperation(patchTaskOp(10, 'IN_PROGRESS')));
    await store.dispatch(submitOperation(patchTaskOp(10, 'COMPLETE')));

    const entries = store.getState().outbox.entries;
    expect(entries).toHaveLength(2);
    expect((entries[1].op as any).body.value).toBe('COMPLETE');
  });

  it('marks entries the server rejects as failed and keeps going', async () => {
    mockedApi.post.mockRejectedValue(networkError());
    const store = makeStore();
    await store.dispatch(submitOperation(commentOp('bad')));
    await store.dispatch(submitOperation(commentOp('good')));

    mockedApi.post.mockReset();
    mockedApi.post
      .mockRejectedValueOnce(httpError(403, 'Access denied'))
      .mockResolvedValueOnce({ id: 5, content: 'good' });
    await store.dispatch(processOutbox());

    const entries = store.getState().outbox.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      status: 'failed',
      error: 'Access denied'
    });
    expect(store.getState().comments.commentsByWorkOrder[1]).toHaveLength(1);
  });

  it('throws and drops the change when the server rejects it immediately', async () => {
    mockedApi.post.mockRejectedValue(httpError(400, 'Invalid'));
    const store = makeStore();
    await expect(
      store.dispatch(submitOperation(commentOp('x')))
    ).rejects.toThrow('Invalid');
    expect(store.getState().outbox.entries).toHaveLength(0);
  });

  it('keeps entries on transient server errors', async () => {
    mockedApi.post.mockRejectedValue(httpError(503));
    const store = makeStore();
    await expect(store.dispatch(submitOperation(commentOp('x')))).resolves.toBe(
      'queued'
    );
    expect(store.getState().outbox.entries[0].status).toBe('pending');
  });

  it('retries and discards failed entries on request', async () => {
    mockedApi.post.mockRejectedValue(networkError());
    const store = makeStore();
    await store.dispatch(submitOperation(commentOp('a')));
    await store.dispatch(submitOperation(commentOp('b')));
    mockedApi.post.mockReset();
    mockedApi.post.mockRejectedValue(httpError(422));
    await store.dispatch(processOutbox());
    const [a, b] = store.getState().outbox.entries;
    expect([a.status, b.status]).toEqual(['failed', 'failed']);

    store.dispatch(discardEntry(a.id));
    mockedApi.post.mockResolvedValue({ id: 9, content: 'b' });
    await store.dispatch(retryEntry(b.id));
    expect(store.getState().outbox.entries).toHaveLength(0);
  });

  it('is cleared on logout', async () => {
    mockedApi.post.mockRejectedValue(networkError());
    const store = makeStore();
    await store.dispatch(submitOperation(commentOp('a')));
    store.dispatch(revertAll());
    expect(store.getState().outbox.entries).toHaveLength(0);
  });
});

describe('merging pending changes', () => {
  const entry = (seq: number, op: any) =>
    ({
      id: `k${seq}`,
      seq,
      createdAt: '2026-10-26T10:00:00Z',
      op,
      status: 'pending',
      attempts: 0
    } as any);

  it('applies queued task changes over the server data', () => {
    const tasks = [task(10, 'OPEN'), task(11, 'OPEN')];
    const merged = mergePendingTasks(
      tasks,
      [entry(1, patchTaskOp(11, 'COMPLETE'))],
      1
    );
    expect(merged.map((t) => t.value)).toEqual(['OPEN', 'COMPLETE']);
    expect(mergePendingTasks(tasks, [], 1)).toBe(tasks);
  });

  it('shows queued comments first, newest on top, with temporary ids', () => {
    const merged = mergePendingComments(
      [{ id: 3, content: 'old' } as any],
      [entry(1, commentOp('one')), entry(2, commentOp('two'))],
      1
    );
    expect(merged.map((c) => [c.id, c.content])).toEqual([
      [-2, 'two'],
      [-1, 'one'],
      [3, 'old']
    ]);
    expect((merged[0] as any).pending).toBe(true);
  });

  it('only merges changes of the requested work order', () => {
    const other = { ...commentOp('elsewhere'), workOrderId: 2 };
    expect(mergePendingComments([], [entry(1, other)], 1)).toEqual([]);
  });

  it('appends queued time entries', () => {
    const merged = mergePendingLabors(
      [{ id: 1, duration: 60 } as any],
      [
        entry(4, {
          type: 'CREATE_LABOR',
          workOrderId: 1,
          body: { duration: 3600 }
        })
      ],
      1
    );
    expect(merged.map((l) => [l.id, l.duration])).toEqual([
      [1, 60],
      [-4, 3600]
    ]);
  });
});
