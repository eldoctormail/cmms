import * as FileSystem from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * redux-persist storage engine backed by plain files.
 *
 * redux-persist serializes the whole persisted state under a single key. On
 * Android, AsyncStorage keeps each key in one SQLite row and reading a row
 * bigger than ~2MB fails ("Row too big to fit into CursorWindow"), so the
 * state silently stops rehydrating once enough work orders are cached for
 * offline use. Files have no such limit.
 *
 * Falls back to AsyncStorage where there is no document directory (web).
 */
const directory = FileSystem.documentDirectory
  ? `${FileSystem.documentDirectory}redux-persist/`
  : null;

let directoryReady: Promise<void> | null = null;
const pendingWrites = new Map<string, Promise<void>>();

const ensureDirectory = (): Promise<void> => {
  if (!directoryReady) {
    directoryReady = FileSystem.getInfoAsync(directory)
      .then((info) =>
        info.exists
          ? undefined
          : FileSystem.makeDirectoryAsync(directory, { intermediates: true })
      )
      .catch((error) => {
        directoryReady = null;
        throw error;
      });
  }
  return directoryReady;
};

const fileFor = (key: string) => `${directory}${encodeURIComponent(key)}.json`;

const exists = async (path: string) =>
  (await FileSystem.getInfoAsync(path)).exists;

async function writeFile(key: string, value: string): Promise<void> {
  await ensureDirectory();
  const path = fileFor(key);
  // Write to a temporary file and move it into place so a crash mid-write
  // never leaves a truncated (unparseable) state file behind. The target is
  // removed first because iOS refuses to move onto an existing file.
  const tmpPath = `${path}.tmp`;
  await FileSystem.writeAsStringAsync(tmpPath, value);
  await FileSystem.deleteAsync(path, { idempotent: true });
  await FileSystem.moveAsync({ from: tmpPath, to: path });
}

const fileSystemStorage = {
  async getItem(key: string): Promise<string | null> {
    if (!directory) return AsyncStorage.getItem(key);
    const path = fileFor(key);
    if (await exists(path)) return FileSystem.readAsStringAsync(path);
    // A crash between removing the old file and moving the new one into place
    // (see writeFile) leaves only the complete temporary file.
    const tmpPath = `${path}.tmp`;
    if (await exists(tmpPath)) return FileSystem.readAsStringAsync(tmpPath);
    return null;
  },

  setItem(key: string, value: string): Promise<void> {
    if (!directory) return AsyncStorage.setItem(key, value);
    // Serialize writes per key: overlapping writes would share the same
    // temporary file.
    const previous = pendingWrites.get(key) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(() => writeFile(key, value));
    pendingWrites.set(key, write);
    write
      .catch(() => undefined)
      .finally(() => {
        if (pendingWrites.get(key) === write) pendingWrites.delete(key);
      });
    return write;
  },

  async removeItem(key: string): Promise<void> {
    if (!directory) return AsyncStorage.removeItem(key);
    await FileSystem.deleteAsync(fileFor(key), { idempotent: true });
    await FileSystem.deleteAsync(`${fileFor(key)}.tmp`, { idempotent: true });
  }
};

/**
 * The state used to be persisted in AsyncStorage. It is only a cache, so it is
 * not migrated: drop it to free the space it was taking.
 */
export const removeLegacyPersistedState = async (key: string) => {
  if (!directory) return;
  try {
    await AsyncStorage.removeItem(key);
  } catch {
    // Best effort.
  }
};

export default fileSystemStorage;
