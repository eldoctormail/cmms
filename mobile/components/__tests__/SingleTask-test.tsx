import * as React from 'react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest
} from '@jest/globals';
import renderer, { act } from 'react-test-renderer';
import SingleTask from '../SingleTask';
import { Task } from '../../models/tasks';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));
jest.mock('../../hooks/useAuth', () => () => ({
  user: { id: 1 },
  hasCreatePermission: () => true,
  hasFeature: () => true
}));
jest.mock('react-native-actions-sheet', () => ({
  SheetManager: { show: jest.fn() }
}));

const makeTask = (taskType: string, value = ''): Task =>
  ({
    id: 7,
    value,
    notes: '',
    images: [],
    taskBase: { id: 1, label: 'Task', taskType, options: [] }
  } as unknown as Task);

const render = (task: Task, handleChange: ReturnType<typeof jest.fn>) => {
  let root: renderer.ReactTestRenderer;
  act(() => {
    root = renderer.create(
      <SingleTask task={task} handleChange={handleChange} notes={new Map()} />
    );
  });
  return root;
};

const type = (root: renderer.ReactTestRenderer, values: string[]) => {
  const input = root.root.findAll(
    (node) =>
      node.props.label === 'value' &&
      typeof node.props.onChangeText === 'function'
  )[0];
  values.forEach((value) => act(() => input.props.onChangeText(value)));
};

describe('SingleTask value saving', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('saves a numeric value once, after typing stops', () => {
    const handleChange = jest.fn();
    const root = render(makeTask('NUMBER'), handleChange);

    type(root, ['1', '12', '125']);
    expect(handleChange).not.toHaveBeenCalled();

    act(() => jest.advanceTimersByTime(1000));
    expect(handleChange).toHaveBeenCalledTimes(1);
    expect(handleChange).toHaveBeenCalledWith('125', 7);
  });

  it('uses the latest handleChange, not the one from the first render', () => {
    const first = jest.fn();
    const latest = jest.fn();
    const task = makeTask('TEXT');
    const root = render(task, first);

    type(root, ['hello']);
    act(() => {
      root.update(
        <SingleTask task={task} handleChange={latest} notes={new Map()} />
      );
    });
    act(() => jest.advanceTimersByTime(1000));

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith('hello', 7);
  });

  it('flushes a pending value when unmounted', () => {
    const handleChange = jest.fn();
    const root = render(makeTask('TEXT'), handleChange);

    type(root, ['checked']);
    act(() => root.unmount());

    expect(handleChange).toHaveBeenCalledTimes(1);
    expect(handleChange).toHaveBeenCalledWith('checked', 7);
  });
});
