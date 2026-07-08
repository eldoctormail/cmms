/**
 * Basic tests for workOrderDrafts service
 */

import { saveDraft, listDrafts, getDraft, deleteDraft } from '../workOrderDrafts';

beforeEach(() => {
  // @ts-ignore
  global.fetch = jest.fn();
});

afterEach(() => {
  // @ts-ignore
  global.fetch.mockClear();
  // @ts-ignore
  delete global.fetch;
});

test('saveDraft posts payload and returns json', async () => {
  const mockResponse = { id: 1, title: 't', payload: { title: 't' } };
  // @ts-ignore
  global.fetch.mockResolvedValue({ ok: true, json: async () => mockResponse });
  const res = await saveDraft({ title: 't', payload: { title: 't' } });
  expect(res).toEqual(mockResponse);
  expect(global.fetch).toHaveBeenCalledWith('/work-order-drafts', expect.any(Object));
});

test('listDrafts calls GET and returns json', async () => {
  const mockResponse = [{ id: 1 }];
  // @ts-ignore
  global.fetch.mockResolvedValue({ ok: true, json: async () => mockResponse });
  const res = await listDrafts();
  expect(res).toEqual(mockResponse);
  expect(global.fetch).toHaveBeenCalledWith('/work-order-drafts');
});

test('getDraft fetches by id', async () => {
  const mockResponse = { id: 2 };
  // @ts-ignore
  global.fetch.mockResolvedValue({ ok: true, json: async () => mockResponse });
  const res = await getDraft(2);
  expect(res).toEqual(mockResponse);
  expect(global.fetch).toHaveBeenCalledWith('/work-order-drafts/2');
});

test('deleteDraft calls delete', async () => {
  // @ts-ignore
  global.fetch.mockResolvedValue({ ok: true });
  await deleteDraft(3);
  expect(global.fetch).toHaveBeenCalledWith('/work-order-drafts/3', { method: 'DELETE' });
});
