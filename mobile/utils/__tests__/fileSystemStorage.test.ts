import * as FileSystem from 'expo-file-system';
import fileSystemStorage from '../fileSystemStorage';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('expo-file-system', () => {
  const files = new Map<string, string>();
  return {
    __files: files,
    documentDirectory: 'file:///docs/',
    getInfoAsync: jest.fn(async (path: string) => ({
      exists: files.has(path) || path.endsWith('/')
    })),
    makeDirectoryAsync: jest.fn(async () => undefined),
    readAsStringAsync: jest.fn(async (path: string) => files.get(path)),
    writeAsStringAsync: jest.fn(async (path: string, value: string) => {
      files.set(path, value);
    }),
    deleteAsync: jest.fn(async (path: string) => {
      files.delete(path);
    }),
    moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
      if (files.has(to)) throw new Error('destination exists');
      files.set(to, files.get(from));
      files.delete(from);
    })
  };
});

const files: Map<string, string> = (FileSystem as any).__files;
const path = 'file:///docs/redux-persist/persist%3Aroot.json';

describe('fileSystemStorage', () => {
  beforeEach(() => files.clear());

  it('returns null for a missing key', async () => {
    await expect(fileSystemStorage.getItem('persist:root')).resolves.toBeNull();
  });

  it('writes and reads back a value, overwriting the previous one', async () => {
    await fileSystemStorage.setItem('persist:root', 'v1');
    await fileSystemStorage.setItem('persist:root', 'v2');
    await expect(fileSystemStorage.getItem('persist:root')).resolves.toBe('v2');
    expect([...files.keys()]).toEqual([path]);
  });

  it('keeps the last value when writes overlap', async () => {
    await Promise.all([
      fileSystemStorage.setItem('persist:root', 'a'),
      fileSystemStorage.setItem('persist:root', 'b'),
      fileSystemStorage.setItem('persist:root', 'c')
    ]);
    await expect(fileSystemStorage.getItem('persist:root')).resolves.toBe('c');
  });

  it('recovers the temporary file after a crash before the move', async () => {
    files.set(`${path}.tmp`, 'complete');
    await expect(fileSystemStorage.getItem('persist:root')).resolves.toBe(
      'complete'
    );
  });

  it('handles values larger than the AsyncStorage row limit', async () => {
    const big = 'x'.repeat(5 * 1024 * 1024);
    await fileSystemStorage.setItem('persist:root', big);
    await expect(
      fileSystemStorage.getItem('persist:root')
    ).resolves.toHaveLength(big.length);
  });

  it('removes the value', async () => {
    await fileSystemStorage.setItem('persist:root', 'v1');
    await fileSystemStorage.removeItem('persist:root');
    await expect(fileSystemStorage.getItem('persist:root')).resolves.toBeNull();
  });
});
