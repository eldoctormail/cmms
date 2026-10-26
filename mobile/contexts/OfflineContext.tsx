import {
  createContext,
  FC,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState
} from 'react';
import { AppState } from 'react-native';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import useAuth from '../hooks/useAuth';
import { useDispatch, useSelector } from '../store';
import { syncOfflineWorkOrders } from '../slices/offline';
import { processOutbox } from '../slices/outbox';

/** Re-sync when the app comes to the foreground and the data is older. */
const FOREGROUND_SYNC_INTERVAL_MS = 15 * 60 * 1000;

interface OfflineContextValue {
  /** True when the device has no connectivity. */
  isOffline: boolean;
  /** ISO date of the last successful offline sync, null if never synced. */
  syncedAt: string | null;
  syncing: boolean;
  syncNow: () => Promise<void>;
}

const OfflineContext = createContext<OfflineContextValue>({
  isOffline: false,
  syncedAt: null,
  syncing: false,
  syncNow: async () => {}
});

// isInternetReachable is null while unknown; only treat a confirmed false as
// offline so the app doesn't flash an offline banner at startup.
export const isOfflineState = (state: NetInfoState) =>
  state.isConnected === false || state.isInternetReachable === false;

export const OfflineProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const dispatch = useDispatch();
  const { isAuthenticated, user } = useAuth();
  const { syncedAt } = useSelector((state) => state.offline);
  const [isOffline, setIsOffline] = useState<boolean>(false);
  const [syncing, setSyncing] = useState<boolean>(false);
  const syncedAtRef = useRef(syncedAt);
  syncedAtRef.current = syncedAt;

  const canSync = isAuthenticated && !!user;

  const hasQueuedChanges = useSelector((state) =>
    state.outbox.entries.some((e) => e.status === 'pending')
  );
  const hasQueuedChangesRef = useRef(hasQueuedChanges);
  hasQueuedChangesRef.current = hasQueuedChanges;

  const sendQueuedChanges = useCallback(async () => {
    if (!canSync) return;
    try {
      await dispatch(processOutbox());
    } catch (error) {
      console.warn('Sending queued changes failed', error);
    }
  }, [canSync, dispatch]);

  const syncNow = useCallback(async () => {
    if (!canSync) return;
    setSyncing(true);
    try {
      // Send what was done offline first, so the data downloaded next
      // already includes it.
      await sendQueuedChanges();
      await dispatch(syncOfflineWorkOrders());
    } catch (error) {
      // Keep the previously synced data; the next trigger retries.
      console.warn('Offline sync failed', error);
    } finally {
      setSyncing(false);
    }
  }, [canSync, dispatch, sendQueuedChanges]);

  // Track connectivity and sync when it comes back.
  useEffect(() => {
    let wasOffline: boolean | null = null;
    return NetInfo.addEventListener((netState) => {
      const offline = isOfflineState(netState);
      setIsOffline(offline);
      if (wasOffline && !offline) syncNow();
      wasOffline = offline;
    });
  }, [syncNow]);

  // Sync on login / app start.
  useEffect(() => {
    if (canSync) syncNow();
  }, [canSync, user?.id]);

  // Sync when the app returns to the foreground with stale data.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') return;
      const lastSync = syncedAtRef.current
        ? new Date(syncedAtRef.current).getTime()
        : 0;
      if (Date.now() - lastSync > FOREGROUND_SYNC_INTERVAL_MS) syncNow();
      else if (hasQueuedChangesRef.current) sendQueuedChanges();
    });
    return () => subscription.remove();
  }, [syncNow, sendQueuedChanges]);

  return (
    <OfflineContext.Provider value={{ isOffline, syncedAt, syncing, syncNow }}>
      {children}
    </OfflineContext.Provider>
  );
};

export const useOffline = () => useContext(OfflineContext);

export default OfflineContext;
