import AsyncStorage from '@react-native-async-storage/async-storage';
import api, { refreshAccessToken, setConflictErrorHandler } from '../api';

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

describe('extra headers and conflicts', () => {
  beforeEach(async () => {
    mockFetch.mockReset();
    await AsyncStorage.clear();
    await AsyncStorage.setItem('accessToken', 'token');
  });

  it('adds extra headers to the default ones', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));
    await api.patch(
      'tasks/1',
      {},
      {
        extraHeaders: { 'If-Unmodified-Since': 'Mon, 26 Oct 2026 10:00:00 GMT' }
      },
      true
    );
    expect(mockFetch.mock.calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer token',
      'If-Unmodified-Since': 'Mon, 26 Oct 2026 10:00:00 GMT'
    });
  });

  it('exposes Retry-After and lets outbox requests handle conflicts', async () => {
    const handler = jest.fn();
    const unsubscribe = setConflictErrorHandler(handler);
    mockFetch.mockResolvedValueOnce({
      ...jsonResponse(409),
      headers: { get: (name: string) => (name === 'Retry-After' ? '1' : null) }
    });

    await expect(
      api.post('comments', {}, { idempotencyKey: 'k' })
    ).rejects.toMatchObject({ status: 409, retryAfter: '1' });
    expect(handler).not.toHaveBeenCalled();

    mockFetch.mockResolvedValueOnce({
      ...jsonResponse(409),
      headers: { get: () => null }
    });
    await expect(api.post('comments', {})).rejects.toMatchObject({
      status: 409
    });
    expect(handler).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
