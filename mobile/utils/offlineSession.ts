import AsyncStorage from '@react-native-async-storage/async-storage';
import { UserResponseDTO } from '../models/user';
import { Company } from '../models/company';

/**
 * Last user and company loaded from the server, so the app can start without
 * connectivity. Only used while the refresh token is still stored, i.e. the
 * session was not revoked or logged out.
 */
const OFFLINE_SESSION_KEY = 'offlineSession';

export interface OfflineSession {
  user: UserResponseDTO;
  company: Company;
}

export const saveOfflineSession = async (session: OfflineSession) => {
  try {
    await AsyncStorage.setItem(OFFLINE_SESSION_KEY, JSON.stringify(session));
  } catch {
    // Caching is best effort; the online session works without it.
  }
};

export const loadOfflineSession = async (): Promise<OfflineSession | null> => {
  try {
    const [raw, refreshToken] = await Promise.all([
      AsyncStorage.getItem(OFFLINE_SESSION_KEY),
      AsyncStorage.getItem('refreshToken')
    ]);
    if (!raw || !refreshToken) return null;
    const session: OfflineSession = JSON.parse(raw);
    return session?.user && session?.company?.companySettings ? session : null;
  } catch {
    return null;
  }
};

export const clearOfflineSession = async () => {
  try {
    await AsyncStorage.removeItem(OFFLINE_SESSION_KEY);
  } catch {
    // Best effort.
  }
};
