import type { ApiModelUsage, ApiUsageSample, ApiUsageStats, ApiUsageTotals } from '../shared/types';
import { AppError } from './errors';
import { atomicWrite, readOptional } from './files';

function emptyTotals(): ApiUsageTotals {
  return { requests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheReportedInputTokens: 0 };
}

function add(a: ApiUsageTotals, b: ApiUsageTotals): ApiUsageTotals {
  return {
    requests: a.requests + b.requests,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheReportedInputTokens: a.cacheReportedInputTokens + b.cacheReportedInputTokens,
  };
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validIdentity(profileId: unknown, model: unknown): boolean {
  return typeof profileId === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(profileId) &&
    typeof model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model);
}

function validTotals(row: ApiUsageTotals): boolean {
  return count(row.requests) && count(row.inputTokens) && count(row.outputTokens) &&
    count(row.inputTokens + row.outputTokens) && count(row.cachedInputTokens) &&
    count(row.cacheReportedInputTokens) && row.cachedInputTokens <= row.cacheReportedInputTokens &&
    row.cacheReportedInputTokens <= row.inputTokens;
}

function modelKey({ profileId, model }: Pick<ApiUsageSample, 'profileId' | 'model'>): string {
  return JSON.stringify([profileId, model]);
}

export class UsageStore {
  private models = new Map<string, ApiModelUsage>();
  private totals = emptyTotals();
  private revision = 0;
  private savedRevision = 0;
  private writes = Promise.resolve();
  private loadFailed = false;

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readOptional(this.path);
      if (raw === null) return;
      const data = JSON.parse(raw) as { version: number; models: unknown[] } | null;
      if (data?.version !== 1 || !Array.isArray(data.models)) throw new AppError('USAGE_STATS_READ_FAILED');
      const models = new Map<string, ApiModelUsage>();
      let totals = emptyTotals();
      for (const item of data.models) {
        if (!item || typeof item !== 'object') throw new AppError('USAGE_STATS_READ_FAILED');
        const row = item as ApiModelUsage;
        if (!validIdentity(row.profileId, row.model) || !validTotals(row) || !row.requests) {
          throw new AppError('USAGE_STATS_READ_FAILED');
        }
        const key = modelKey(row);
        if (models.has(key)) throw new AppError('USAGE_STATS_READ_FAILED');
        models.set(key, { profileId: row.profileId, model: row.model, ...add(emptyTotals(), row) });
        totals = add(totals, row);
      }
      if (!validTotals(totals)) throw new AppError('USAGE_STATS_READ_FAILED');
      this.models = models;
      this.totals = totals;
    } catch {
      this.loadFailed = true;
      throw new AppError('USAGE_STATS_READ_FAILED');
    }
  }

  record(sample: ApiUsageSample): void {
    const { profileId, model, inputTokens, outputTokens } = sample;
    if (this.loadFailed || !validIdentity(profileId, model) || !count(inputTokens) || !count(outputTokens)) return;
    const cached = count(sample.cachedInputTokens) && sample.cachedInputTokens <= inputTokens ? sample.cachedInputTokens : null;
    const delta = {
      requests: 1, inputTokens, outputTokens, cachedInputTokens: cached ?? 0,
      cacheReportedInputTokens: cached === null ? 0 : inputTokens,
    };
    const totals = add(this.totals, delta);
    if (!validTotals(totals)) return;
    const key = modelKey(sample);
    const modelTotals = add(this.models.get(key) ?? emptyTotals(), delta);
    this.models.set(key, { profileId, model, ...modelTotals });
    this.totals = totals;
    this.revision++;
    void this.flush().catch(() => undefined);
  }

  async getStats(): Promise<ApiUsageStats> {
    await this.flush();
    return { ...this.totals, models: [...this.models.values()].map((row) => ({ ...row })) };
  }

  async flush(): Promise<void> {
    if (this.loadFailed) throw new AppError('USAGE_STATS_READ_FAILED');
    // Serialize commits so a slower write cannot overwrite a newer snapshot.
    const write = this.writes.then(async () => {
      const revision = this.revision;
      if (revision === this.savedRevision) return;
      const data = { version: 1, models: [...this.models.values()] };
      try { await atomicWrite(this.path, JSON.stringify(data, null, 2) + '\n'); }
      catch { throw new AppError('USAGE_STATS_WRITE_FAILED'); }
      this.savedRevision = revision;
    });
    this.writes = write.catch(() => undefined);
    await write;
  }
}
