import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as files from '../electron/files';
import { UsageStore } from '../electron/usage';
import type { ApiUsageSample } from '../shared/types';

const SAMPLE: ApiUsageSample = {
  profileId: 'first-api', model: 'shared/model', inputTokens: 100, outputTokens: 10, cachedInputTokens: null,
};

let directory: string;
let path: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agent-switcher-usage-test-'));
  path = join(directory, 'api-usage.json');
});

afterEach(async () => {
  vi.restoreAllMocks();
  const target = resolve(directory);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('agent-switcher-usage-test-')) {
    throw new Error('Unsafe test cleanup target');
  }
  await rm(target, { recursive: true, force: true });
});

describe('API usage store', () => {
  it('keeps models and profiles separate, and distinguishes an unknown cache count from zero', async () => {
    const store = new UsageStore(path);
    await store.load();
    await expect(store.getStats()).resolves.toEqual({
      requests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheReportedInputTokens: 0, models: [],
    });

    store.record(SAMPLE);
    store.record({ ...SAMPLE, inputTokens: 50, outputTokens: 5, cachedInputTokens: 0 });
    store.record({ ...SAMPLE, inputTokens: 30, outputTokens: 3, cachedInputTokens: 12 });
    store.record({ ...SAMPLE, inputTokens: 20, outputTokens: 2, cachedInputTokens: 20, profileId: 'second-api' });
    store.record({ ...SAMPLE, inputTokens: 10, outputTokens: 1, cachedInputTokens: 11, model: 'another-model' });

    const stats = await store.getStats();
    expect(stats).toEqual({
      requests: 5, inputTokens: 210, outputTokens: 21, cachedInputTokens: 32, cacheReportedInputTokens: 100,
      models: expect.arrayContaining([
        {
          profileId: 'first-api', model: 'shared/model', requests: 3,
          inputTokens: 180, outputTokens: 18, cachedInputTokens: 12, cacheReportedInputTokens: 80,
        },
        {
          profileId: 'second-api', model: 'shared/model', requests: 1,
          inputTokens: 20, outputTokens: 2, cachedInputTokens: 20, cacheReportedInputTokens: 20,
        },
        {
          profileId: 'first-api', model: 'another-model', requests: 1,
          inputTokens: 10, outputTokens: 1, cachedInputTokens: 0, cacheReportedInputTokens: 0,
        },
      ]),
    });
    expect(stats.models).toHaveLength(3);
    await store.flush();
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, models: stats.models });

    const reopened = new UsageStore(path);
    await reopened.load();
    await expect(reopened.getStats()).resolves.toEqual(stats);
  });

  it('serializes in-flight saves and coalesces later samples without losing counts', async () => {
    const store = new UsageStore(path);
    await store.load();
    const write = files.atomicWrite;
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const firstReleased = new Promise<void>((resolve) => { release = resolve; });
    const writes = vi.spyOn(files, 'atomicWrite').mockImplementationOnce(async (...args) => {
      started();
      await firstReleased;
      await write(...args);
    });

    store.record(SAMPLE);
    const firstFlush = store.flush();
    await firstStarted;
    for (let index = 0; index < 8; index++) {
      store.record(SAMPLE);
    }
    const pending = [store.flush(), store.getStats(), store.flush()];
    await new Promise<void>((finish) => setImmediate(finish));
    const startedBeforeRelease = writes.mock.calls.length;
    release();
    await Promise.all([firstFlush, ...pending]);

    expect(startedBeforeRelease).toBe(1);
    expect(writes).toHaveBeenCalledTimes(2);
    const reopened = new UsageStore(path);
    await reopened.load();
    await expect(reopened.getStats()).resolves.toMatchObject({ requests: 9, inputTokens: 900, outputTokens: 90 });
  });

  it.each(['{partial document', JSON.stringify({ version: 2, models: [] })])(
    'reports unreadable usage data without overwriting it (%s)', async (original) => {
      await writeFile(path, original);
      const store = new UsageStore(path);
      await expect(store.load()).rejects.toThrow('USAGE_STATS_READ_FAILED');

      store.record(SAMPLE);
      await expect(store.getStats()).rejects.toThrow('USAGE_STATS_READ_FAILED');
      expect(await readFile(path, 'utf8')).toBe(original);
    },
  );

  it('retains pending samples after write failures and retries against the last good document', async () => {
    const store = new UsageStore(path);
    await store.load();
    store.record(SAMPLE);
    await store.flush();
    const original = await readFile(path, 'utf8');
    const writes = vi.spyOn(files, 'atomicWrite').mockRejectedValue(new Error('fixture write failed'));

    store.record({ ...SAMPLE, cachedInputTokens: 25 });
    await expect(store.getStats()).rejects.toThrow('USAGE_STATS_WRITE_FAILED');
    store.record({ ...SAMPLE, cachedInputTokens: 0 });
    await expect(store.flush()).rejects.toThrow('USAGE_STATS_WRITE_FAILED');
    expect(await readFile(path, 'utf8')).toBe(original);

    writes.mockRestore();
    await expect(store.getStats()).resolves.toMatchObject({
      requests: 3, inputTokens: 300, outputTokens: 30, cachedInputTokens: 25, cacheReportedInputTokens: 200,
    });
    const reopened = new UsageStore(path);
    await reopened.load();
    await expect(reopened.getStats()).resolves.toEqual(await store.getStats());
  });
});
