import type { PayloadAction } from '@reduxjs/toolkit';
import { createSlice } from '@reduxjs/toolkit';
import type { AppThunk } from '../store';
import api, { isNetworkError } from '../utils/api';
import { revertAll } from '../utils/redux';
import { Task } from '../models/tasks';
import Comment, { CommentPostDTO } from '../models/comment';
import Labor from '../models/labor';
import { UserMiniDTO } from '../models/user';
import taskSlice from './task';
import commentSlice from './comment';
import laborSlice from './labor';

/**
 * Offline outbox: writes made in a work order are queued here and sent in
 * order when the server is reachable, so a technician can keep working without
 * signal. The queue is part of the persisted store, so it survives restarts.
 *
 * Screens never read queued changes from the regular slices: pending entries
 * are merged in when reading (see the merge helpers below), so refetching data
 * from the server never hides a change that is still waiting to be sent.
 */

export type OutboxOperation =
  | {
      type: 'PATCH_TASK';
      workOrderId: number;
      taskId: number;
      /** Full task as the task endpoint expects it, with the change applied. */
      body: Task;
    }
  | {
      type: 'CREATE_COMMENT';
      workOrderId: number;
      body: CommentPostDTO;
      /** Shown as the author of the comment until it is sent. */
      author: UserMiniDTO;
    }
  | {
      type: 'CREATE_LABOR';
      workOrderId: number;
      body: Partial<Labor>;
    };

export interface OutboxEntry {
  /** Also sent as the Idempotency-Key header. */
  id: string;
  /** Increasing number, used to build temporary negative ids. */
  seq: number;
  createdAt: string;
  op: OutboxOperation;
  status: 'pending' | 'failed';
  attempts: number;
  /** Error message of a failed entry, shown so the user can decide. */
  error?: string;
}

interface OutboxState {
  entries: OutboxEntry[];
  nextSeq: number;
}

const initialState: OutboxState = {
  entries: [],
  nextSeq: 1
};

let keyCounter = 0;
const newKey = () =>
  `${Date.now().toString(36)}-${(keyCounter++).toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;

/** Entry currently being sent; it must not be modified meanwhile. */
let inFlightId: string | null = null;

const slice = createSlice({
  name: 'outbox',
  initialState,
  extraReducers: (builder) => builder.addCase(revertAll, () => initialState),
  reducers: {
    enqueue(
      state: OutboxState,
      action: PayloadAction<{
        id: string;
        createdAt: string;
        op: OutboxOperation;
        /** Entry being sent right now, which must not be modified. */
        inFlightId: string | null;
      }>
    ) {
      const { id, createdAt, op, inFlightId } = action.payload;
      // Only the latest state of a task matters: fold a new change into a
      // pending change of the same task instead of sending both. Entries
      // already attempted are left alone: the server may have stored their
      // idempotency key with the old body.
      if (op.type === 'PATCH_TASK') {
        const previous = state.entries.find(
          (entry) =>
            entry.status === 'pending' &&
            entry.attempts === 0 &&
            entry.id !== inFlightId &&
            entry.op.type === 'PATCH_TASK' &&
            entry.op.taskId === op.taskId
        );
        if (previous) {
          previous.op = op;
          return;
        }
      }
      state.entries.push({
        id,
        seq: state.nextSeq,
        createdAt,
        op,
        status: 'pending',
        attempts: 0
      });
      state.nextSeq += 1;
    },
    remove(state: OutboxState, action: PayloadAction<{ id: string }>) {
      state.entries = state.entries.filter(
        (entry) => entry.id !== action.payload.id
      );
    },
    markAttempt(state: OutboxState, action: PayloadAction<{ id: string }>) {
      const entry = state.entries.find((e) => e.id === action.payload.id);
      if (entry) entry.attempts += 1;
    },
    markFailed(
      state: OutboxState,
      action: PayloadAction<{ id: string; error: string }>
    ) {
      const entry = state.entries.find((e) => e.id === action.payload.id);
      if (entry) {
        entry.status = 'failed';
        entry.error = action.payload.error;
      }
    },
    retry(state: OutboxState, action: PayloadAction<{ id: string }>) {
      const entry = state.entries.find((e) => e.id === action.payload.id);
      if (entry) {
        entry.status = 'pending';
        entry.error = undefined;
      }
    }
  }
});

export const reducer = slice.reducer;

const findEntry = (state: { outbox?: OutboxState }, id: string) =>
  state.outbox?.entries.find((entry) => entry.id === id);

/** Errors worth retrying later rather than asking the user what to do. */
export const isTransientError = (error: any): boolean => {
  if (isNetworkError(error)) return true;
  const status = error?.status;
  // 401: the session could not be refreshed now; keep the change for later.
  return status === 401 || status === 429 || (status >= 500 && status < 600);
};

const errorMessage = (error: any): string => {
  if (error?.status === 409) return 'conflict_error';
  try {
    return JSON.parse(error?.message)?.message ?? String(error?.message);
  } catch {
    return String(error?.message ?? error);
  }
};

const send =
  (entry: OutboxEntry): AppThunk =>
  async (dispatch) => {
    const options = { idempotencyKey: entry.id };
    const { op } = entry;
    switch (op.type) {
      case 'PATCH_TASK': {
        const task = await api.patch<Task>(
          `tasks/${op.taskId}`,
          op.body,
          options,
          true
        );
        dispatch(
          taskSlice.actions.patchTask({ workOrderId: op.workOrderId, task })
        );
        return;
      }
      case 'CREATE_COMMENT': {
        const comment = await api.post<Comment>('comments', op.body, options);
        dispatch(
          commentSlice.actions.addComment({
            workOrderId: op.workOrderId,
            comment
          })
        );
        return;
      }
      case 'CREATE_LABOR': {
        const labor = await api.post<Labor>(
          'labors',
          { ...op.body, workOrder: { id: op.workOrderId } },
          options
        );
        dispatch(
          laborSlice.actions.createLabor({
            workOrderId: op.workOrderId,
            labor
          })
        );
        return;
      }
    }
  };

/**
 * One pass over the queue, oldest first. Stops at the first transient error
 * (later entries would fail the same way and must not overtake it); entries
 * rejected by the server are marked failed and skipped.
 */
const runPass = (): AppThunk => async (dispatch, getState) => {
  const ids = getState().outbox.entries.map((entry) => entry.id);
  for (const id of ids) {
    const entry = findEntry(getState(), id);
    if (!entry || entry.status !== 'pending') continue;
    inFlightId = id;
    try {
      dispatch(slice.actions.markAttempt({ id }));
      await dispatch(send(findEntry(getState(), id)));
      dispatch(slice.actions.remove({ id }));
    } catch (error) {
      if (isTransientError(error)) return;
      dispatch(slice.actions.markFailed({ id, error: errorMessage(error) }));
    } finally {
      inFlightId = null;
    }
  }
};

let processing: Promise<void> | null = null;
let rerun = false;

/**
 * Sends the queued changes. Calls made while a pass is running are folded
 * into it (another pass runs right after), so awaiting the returned promise
 * guarantees entries queued before the call were attempted.
 */
export const processOutbox = (): AppThunk => (dispatch) => {
  if (processing) {
    rerun = true;
    return processing;
  }
  processing = (async () => {
    do {
      rerun = false;
      await dispatch(runPass());
    } while (rerun);
  })().finally(() => {
    processing = null;
  });
  return processing;
};

export type SubmitResult = 'sent' | 'queued';

/**
 * Queues a change and tries to send it right away. Resolves 'sent' when the
 * server accepted it and 'queued' when it will be sent once the server is
 * reachable. If the server rejects it, the change is dropped and the error is
 * thrown, as a direct request would.
 */
export const submitOperation =
  (op: OutboxOperation): AppThunk =>
  async (dispatch, getState): Promise<SubmitResult> => {
    const id = newKey();
    dispatch(
      slice.actions.enqueue({
        id,
        createdAt: new Date().toISOString(),
        op,
        inFlightId
      })
    );
    await dispatch(processOutbox());
    // A task change folded into an earlier entry is tracked by that entry.
    const entry =
      findEntry(getState(), id) ??
      (op.type === 'PATCH_TASK'
        ? getState().outbox.entries.find(
            (e) =>
              e.op.type === 'PATCH_TASK' &&
              e.op.taskId === op.taskId &&
              e.op.body === op.body
          )
        : undefined);
    if (!entry) return 'sent';
    if (entry.status === 'failed') {
      dispatch(slice.actions.remove({ id: entry.id }));
      const error = new Error(JSON.stringify({ message: entry.error }));
      throw error;
    }
    return 'queued';
  };

/** Puts a failed entry back in the queue and tries again. */
export const retryEntry =
  (id: string): AppThunk =>
  async (dispatch) => {
    dispatch(slice.actions.retry({ id }));
    await dispatch(processOutbox());
  };

/** Drops a failed entry; the change is lost. */
export const discardEntry =
  (id: string): AppThunk =>
  async (dispatch) => {
    dispatch(slice.actions.remove({ id }));
  };

// ---- Merging queued changes into what screens show ----

const entriesFor = (entries: OutboxEntry[], workOrderId: number) =>
  entries.filter((entry) => entry.op.workOrderId === workOrderId);

export const mergePendingTasks = (
  tasks: Task[],
  entries: OutboxEntry[],
  workOrderId: number
): Task[] => {
  const changes = new Map<number, Task>();
  entriesFor(entries, workOrderId).forEach(({ op }) => {
    if (op.type === 'PATCH_TASK') changes.set(op.taskId, op.body);
  });
  if (!changes.size) return tasks;
  return tasks.map((task) =>
    changes.has(task.id) ? { ...task, ...changes.get(task.id) } : task
  );
};

export type PendingComment = Comment & { pending: true };

export const mergePendingComments = (
  comments: Comment[],
  entries: OutboxEntry[],
  workOrderId: number
): (Comment | PendingComment)[] => {
  const pending: PendingComment[] = [];
  entriesFor(entries, workOrderId).forEach(({ op, seq, createdAt }) => {
    if (op.type !== 'CREATE_COMMENT') return;
    pending.push({
      id: -seq,
      content: op.body.content,
      user: op.author,
      files: [],
      system: false,
      createdAt,
      updatedAt: createdAt,
      createdBy: op.author?.id,
      updatedBy: op.author?.id,
      pending: true
    } as PendingComment);
  });
  if (!pending.length) return comments;
  // Comments are shown newest first.
  return [...pending.reverse(), ...comments];
};

export type PendingLabor = Labor & { pending: true };

export const mergePendingLabors = (
  labors: Labor[],
  entries: OutboxEntry[],
  workOrderId: number
): (Labor | PendingLabor)[] => {
  const pending: PendingLabor[] = [];
  entriesFor(entries, workOrderId).forEach(({ op, seq }) => {
    if (op.type !== 'CREATE_LABOR') return;
    pending.push({ ...op.body, id: -seq, pending: true } as PendingLabor);
  });
  return pending.length ? [...labors, ...pending] : labors;
};

export default slice;
