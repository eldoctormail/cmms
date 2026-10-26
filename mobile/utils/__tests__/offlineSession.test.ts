import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  clearOfflineSession,
  loadOfflineSession,
  saveOfflineSession
} from '../offlineSession';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const session = {
  user: { id: 1, companyId: 7 },
  company: { id: 7, companySettings: { generalPreferences: {} } }
} as any;

describe('offlineSession', () => {
  beforeEach(() => AsyncStorage.clear());

  it('restores the saved session while the refresh token is stored', async () => {
    await AsyncStorage.setItem('refreshToken', 'r');
    await saveOfflineSession(session);
    await expect(loadOfflineSession()).resolves.toEqual(session);
  });

  it('does not restore a session without refresh token', async () => {
    await saveOfflineSession(session);
    await expect(loadOfflineSession()).resolves.toBeNull();
  });

  it('ignores corrupted or incomplete data', async () => {
    await AsyncStorage.setItem('refreshToken', 'r');
    await AsyncStorage.setItem('offlineSession', '{not json');
    await expect(loadOfflineSession()).resolves.toBeNull();
    await AsyncStorage.setItem('offlineSession', JSON.stringify({ user: {} }));
    await expect(loadOfflineSession()).resolves.toBeNull();
  });

  it('clears the saved session', async () => {
    await AsyncStorage.setItem('refreshToken', 'r');
    await saveOfflineSession(session);
    await clearOfflineSession();
    await expect(loadOfflineSession()).resolves.toBeNull();
  });
});
