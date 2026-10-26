import AsyncStorage from '@react-native-async-storage/async-storage';
import api, { refreshAccessToken } from '../api';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('../../config', () => ({
  getApiUrl: jest.fn(async () => 'https://api.example.com/')
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const jsonResponse = (status: number, body: object = {}) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response);

describe('refreshAccessToken', () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    await AsyncStorage.clear();
    await AsyncStorage.setItem('accessToken', 'old-access');
    await AsyncStorage.setItem('refreshToken', 'old-refresh');
  });

  it('stores the new tokens on success', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        accessToken: 'new-access',
        refreshToken: 'new-refresh'
      })
    );

    await expect(refreshAccessToken()).resolves.toBe(true);
    expect(await AsyncStorage.getItem('accessToken')).toBe('new-access');
    expect(await AsyncStorage.getItem('refreshToken')).toBe('new-refresh');
  });

  it('keeps the session when the network is unavailable', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Network request failed'));

    await expect(refreshAccessToken()).resolves.toBe(false);
    expect(await AsyncStorage.getItem('accessToken')).toBe('old-access');
    expect(await AsyncStorage.getItem('refreshToken')).toBe('old-refresh');
  });

  it.each([500, 502, 503, 429])(
    'keeps the session on transient server error %i',
    async (status) => {
      mockFetch.mockResolvedValueOnce(jsonResponse(status));

      await expect(refreshAccessToken()).resolves.toBe(false);
      expect(await AsyncStorage.getItem('refreshToken')).toBe('old-refresh');
    }
  );

  it.each([400, 401, 403])(
    'clears the session when the server rejects the refresh token (%i)',
    async (status) => {
      mockFetch.mockResolvedValueOnce(jsonResponse(status));

      await expect(refreshAccessToken()).resolves.toBe(false);
      expect(await AsyncStorage.getItem('accessToken')).toBeNull();
      expect(await AsyncStorage.getItem('refreshToken')).toBeNull();
    }
  );
});

describe('idempotency key', () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    await AsyncStorage.clear();
    await AsyncStorage.setItem('accessToken', 'token');
  });

  it('is sent as a header next to the authorization', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { id: 1 }));
    await api.post('comments', { content: 'x' }, { idempotencyKey: 'k-1' });

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer token',
      'Idempotency-Key': 'k-1'
    });
    expect(init).not.toHaveProperty('idempotencyKey');
  });

  it('is not sent unless requested', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));
    await api.post('comments', { content: 'x' });
    expect(mockFetch.mock.calls[0][1].headers).not.toHaveProperty(
      'Idempotency-Key'
    );
  });
});
