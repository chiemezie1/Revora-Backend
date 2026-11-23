import { createHash, createHmac } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { AppError } from '../lib/errors';
import { LedgerPeriodLock, LedgerPeriodLockRepository } from '../db/repositories/ledgerPeriodLockRepository';
import { withTransaction } from '../db/transaction';
import {
  JournalEntryExport,
  LedgerService,
  MaterializedExport,
} from './ledgerService';

jest.mock('../db/transaction', () => ({
  withTransaction: jest.fn(),
}));

describe('LedgerService period close dual control', () => {
  const offeringId = 'offering-1';
  const periodId = '2024-01';
  const initiatorId = 'actor-1';
  const confirmerId = 'actor-2';
  const signingKey = '00112233445566778899aabbccddeeff';

  let pool: Pool;
  let lockRepo: {
    getLock: jest.Mock;
    initiatePeriodClose: jest.Mock;
    getInitiatedLock: jest.Mock;
    confirmPeriodClose: jest.Mock;
    getLockedExportMetadata: jest.Mock;
  };
  let client: { query: jest.Mock; release: jest.Mock };
  let service: LedgerService;
  let originalSigningKey: string | undefined;
  let originalSigningKeyVersion: string | undefined;

  const makeLock = (
    overrides: Partial<LedgerPeriodLock> = {},
  ): LedgerPeriodLock => ({
    id: 'lock-1',
    period_id: periodId,
    offering_id: offeringId,
    status: 'initiated',
    initiated_by: initiatorId,
    initiated_at: new Date('2024-01-31T12:00:00.000Z'),
    confirmed_by: null,
    confirmed_at: null,
    locked_at: null,
    export_format: 'jsonl',
    export_reference: null,
    export_hash: null,
    export_signature: null,
    signing_algorithm: 'hmac-sha256-v1',
    signing_key_version: 1,
    entry_count: null,
    created_at: new Date('2024-01-31T12:00:00.000Z'),
    updated_at: new Date('2024-01-31T12:00:00.000Z'),
    ...overrides,
  });

  beforeAll(() => {
    originalSigningKey = process.env.LEDGER_CLOSE_SIGNING_KEY;
    originalSigningKeyVersion = process.env.LEDGER_CLOSE_SIGNING_KEY_VERSION;
  });

  beforeEach(() => {
    process.env.LEDGER_CLOSE_SIGNING_KEY = signingKey;
    process.env.LEDGER_CLOSE_SIGNING_KEY_VERSION = '1';

    pool = {} as Pool;
    client = {
      query: jest.fn(),
      release: jest.fn(),
    };
    lockRepo = {
      getLock: jest.fn(),
      initiatePeriodClose: jest.fn(),
      getInitiatedLock: jest.fn(),
      confirmPeriodClose: jest.fn(),
      getLockedExportMetadata: jest.fn(),
    };
    service = new LedgerService(
      pool,
      lockRepo as unknown as LedgerPeriodLockRepository,
    );

    jest.mocked(withTransaction).mockImplementation(
      async (_pool, callback) =>
        callback(client as unknown as PoolClient),
    );
  });

  afterAll(() => {
    if (originalSigningKey === undefined) {
      delete process.env.LEDGER_CLOSE_SIGNING_KEY;
    } else {
      process.env.LEDGER_CLOSE_SIGNING_KEY = originalSigningKey;
    }
    if (originalSigningKeyVersion === undefined) {
      delete process.env.LEDGER_CLOSE_SIGNING_KEY_VERSION;
    } else {
      process.env.LEDGER_CLOSE_SIGNING_KEY_VERSION = originalSigningKeyVersion;
    }
  });

  it('requires a server signing key at construction', () => {
    delete process.env.LEDGER_CLOSE_SIGNING_KEY;

    expect(
      () =>
        new LedgerService(
          pool,
          lockRepo as unknown as LedgerPeriodLockRepository,
        ),
    ).toThrow('LEDGER_CLOSE_SIGNING_KEY environment variable not set');
  });

  it('creates an initiated lock for a new period', async () => {
    lockRepo.getLock.mockResolvedValue(null);
    lockRepo.initiatePeriodClose.mockResolvedValue(
      makeLock(),
    );

    const result = await service.initiatePeriodClose(
      offeringId,
      periodId,
      initiatorId,
    );

    expect(lockRepo.initiatePeriodClose).toHaveBeenCalledWith({
      period_id: periodId,
      offering_id: offeringId,
      initiated_by: initiatorId,
      export_format: 'jsonl',
    });
    expect(result).toMatchObject({
      lock_id: 'lock-1',
      period_id: periodId,
      offering_id: offeringId,
      status: 'initiated',
      initiated_by: initiatorId,
    });
  });

  it('rejects a period that is already locked', async () => {
    lockRepo.getLock.mockResolvedValue(makeLock({ status: 'locked' }));

    await expect(
      service.initiatePeriodClose(offeringId, periodId, initiatorId),
    ).rejects.toMatchObject<AppError>({
      statusCode: 409,
      message: expect.stringContaining('already locked'),
    });
  });

  it('rejects duplicate initiation while confirmation is pending', async () => {
    lockRepo.getLock.mockResolvedValue(makeLock({ status: 'initiated' }));

    await expect(
      service.initiatePeriodClose(offeringId, periodId, initiatorId),
    ).rejects.toMatchObject<AppError>({
      statusCode: 409,
      message: expect.stringContaining('pending confirmation'),
    });
  });

  it('rejects confirmation by the initiating actor', async () => {
    lockRepo.getInitiatedLock.mockResolvedValue(makeLock());

    await expect(
      service.confirmPeriodClose(offeringId, periodId, initiatorId),
    ).rejects.toMatchObject<AppError>({
      statusCode: 403,
      message: expect.stringContaining('different actor'),
    });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('allows a different actor to confirm and locks the period', async () => {
    const lockedAt = new Date('2024-02-01T00:00:00.000Z');
    lockRepo.getInitiatedLock.mockResolvedValue(makeLock());
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'entry-1',
            offering_id: offeringId,
            period_id: periodId,
            amount: '125.50',
            issuer_id: 'issuer-1',
            reported_at: new Date('2024-01-15T12:00:00.000Z'),
            created_at: new Date('2024-01-15T13:00:00.000Z'),
          },
        ],
      });
    lockRepo.confirmPeriodClose.mockResolvedValue(
      makeLock({
        status: 'locked',
        confirmed_by: confirmerId,
        confirmed_at: lockedAt,
        locked_at: lockedAt,
        export_hash: 'a'.repeat(64),
        export_signature: 'b'.repeat(128),
        entry_count: 1,
      }),
    );

    const result = await service.confirmPeriodClose(
      offeringId,
      periodId,
      confirmerId,
    );

    expect(lockRepo.confirmPeriodClose).toHaveBeenCalledWith(
      'lock-1',
      expect.objectContaining({
        confirmed_by: confirmerId,
        entry_count: 1,
        signing_algorithm: 'hmac-sha256-v1',
        signing_key_version: 1,
      }),
      client,
    );
    expect(result.status).toBe('locked');
    expect(result.confirmed_by).toBe(confirmerId);
  });

  it('returns not found when no initiated lock exists', async () => {
    lockRepo.getInitiatedLock.mockResolvedValue(null);

    await expect(
      service.confirmPeriodClose(offeringId, periodId, confirmerId),
    ).rejects.toMatchObject<AppError>({
      statusCode: 404,
      message: expect.stringContaining('No initiated close found'),
    });
  });

  it('computes a reproducible SHA-256 hash for fixed entries', () => {
    const entries: JournalEntryExport[] = [
      {
        id: 'entry-1',
        offering_id: offeringId,
        period_id: periodId,
        amount: '125.50',
        issuer_id: 'issuer-1',
        reported_at: '2024-01-15T12:00:00.000Z',
        created_at: '2024-01-15T13:00:00.000Z',
      },
    ];
    const materialized: MaterializedExport = {
      format: 'jsonl',
      entries,
      period_id: periodId,
      offering_id: offeringId,
      entry_count: 1,
      exported_at: '2024-02-01T00:00:00.000Z',
    };

    const internals = service as unknown as {
      computeExportHash: (value: MaterializedExport) => string;
    };
    const hash = internals.computeExportHash(materialized);

    expect(hash).toBe(
      createHash('sha256')
        .update(JSON.stringify(entries[0]))
        .digest('hex'),
    );
    expect(hash).toBe(internals.computeExportHash(materialized));
  });

  it('computes the deterministic HMAC signature for a fixed hash', () => {
    const exportHash = 'a'.repeat(64);
    const internals = service as unknown as {
      signExportHash: (hash: string) => string;
    };

    const signature = internals.signExportHash(exportHash);

    expect(signature).toBe(
      createHmac('sha256', Buffer.from(signingKey, 'hex'))
        .update(exportHash)
        .digest('hex'),
    );
    expect(signature).toBe(internals.signExportHash(exportHash));
  });

  it('verifies only a valid matching HMAC signature', () => {
    const exportHash = 'a'.repeat(64);
    const internals = service as unknown as {
      signExportHash: (hash: string) => string;
    };
    const signature = internals.signExportHash(exportHash);

    expect(service.verifyExportSignature(exportHash, signature)).toBe(true);
    expect(service.verifyExportSignature(exportHash, '0'.repeat(64))).toBe(false);
    expect(service.verifyExportSignature(exportHash, 'not-a-signature')).toBe(false);
  });

  it('returns null for metadata when the period is not locked', async () => {
    lockRepo.getLockedExportMetadata.mockResolvedValue(null);

    await expect(
      service.getLockedPeriodMetadata(offeringId, periodId),
    ).resolves.toBeNull();
  });
});
