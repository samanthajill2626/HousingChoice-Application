import { describe, expect, it } from 'vitest';
import type { RankingJobView } from '../../../api/index.js';
import {
  ANCHOR_NOTE_TEXT,
  NOT_RANKED_YET,
  NOT_SCORED,
  anchorParam,
  bandLabel,
  cappedText,
  currentMatchText,
  directionLabel,
  finishedBatchCount,
  formatCost,
  isJobLive,
  jobStatusText,
  notScoredCount,
  outOfDateText,
  parseAnchorParam,
  reasonsText,
} from './rankingFormat.js';

function job(over: Partial<RankingJobView> = {}): RankingJobView {
  return {
    status: 'queued',
    generation: 'gen-1',
    includeOlder: false,
    requestedAt: '2026-07-01T12:00:00.000Z',
    batchCount: 0,
    batchesDone: [],
    failedBatches: [],
    notScored: [],
    ...over,
  };
}

describe('rankingFormat', () => {
  it('names the four bands', () => {
    expect([bandLabel('strong'), bandLabel('good'), bandLabel('possible'), bandLabel('weak')]).toEqual([
      'Strong',
      'Good',
      'Possible',
      'Weak',
    ]);
  });

  it('uses the spec wording for an unranked and an unscored row', () => {
    expect(NOT_RANKED_YET).toBe('not ranked yet');
    expect(NOT_SCORED).toBe('not scored - retry');
  });

  it('says capped with its one reason, or No', () => {
    expect(cappedText(true)).toBe('Capped: requirement not met');
    expect(cappedText(false)).toBe('No');
  });

  it('lists every out-of-date reason in plain words, and a dash when current', () => {
    expect(outOfDateText([])).toBe('-');
    expect(outOfDateText(['card', 'pairHistory', 'age', 'version', 'failedBatch', 'unverified'])).toBe(
      'Out of date: a card changed, their history changed, too old, the rubric or model changed, ' +
        'the last ranking failed for it, could not check whether this match is current',
    );
  });

  it('writes reasons with their sources', () => {
    expect(reasonsText([])).toBe('-');
    expect(
      reasonsText([
        { text: 'Rent fits', source: 'rent' },
        { text: 'Said no stairs', source: 'staff_notes' },
      ]),
    ).toBe('Rent fits (rent); Said no stairs (staff notes)');
  });

  it('says what each anchor note means', () => {
    expect(ANCHOR_NOTE_TEXT).toEqual({
      not_searching: 'This tenant is not searching.',
      not_sendable: 'This tenant cannot be texted.',
      not_available: 'This property is not available.',
    });
  });

  it('names the direction for staff (property, never unit)', () => {
    expect(directionLabel('tenants_for_property')).toBe('Tenants for property');
    expect(directionLabel('properties_for_tenant')).toBe('Properties for tenant');
  });

  it('shows cost in dollars to four places', () => {
    expect(formatCost(0)).toBe('$0.0000');
    expect(formatCost(0.0812345)).toBe('$0.0812');
    expect(formatCost(12.5)).toBe('$12.5000');
  });

  it('a job is live while queued or running', () => {
    expect(isJobLive('queued')).toBe(true);
    expect(isJobLive('running')).toBe(true);
    expect(isJobLive('done')).toBe(false);
    expect(isJobLive('failed')).toBe(false);
    expect(isJobLive('expired')).toBe(false);
  });

  it('states the job: progress in finished batches, a loss in candidates (plan PR42)', () => {
    expect(jobStatusText(job())).toBe('Waiting for a free slot');
    // batchCount stays 0 until the pool is built (plan IR31).
    expect(jobStatusText(job({ status: 'running' }))).toBe('Ranking...');
    expect(
      jobStatusText(job({ status: 'running', batchCount: 3, batchesDone: [0], failedBatches: [{ index: 2, candidateIds: ['c5'], failure: 'timeout' }] })),
    ).toBe('Ranking: 2 of 3 batches finished; 1 candidate not scored');
    expect(jobStatusText(job({ status: 'running', batchCount: 3, batchesDone: [0] }))).toBe('Ranking: 1 of 3 batches finished');
    expect(jobStatusText(job({ status: 'done', batchCount: 2, batchesDone: [0, 1] }))).toBe('Done: 2 batches');
    expect(jobStatusText(job({ status: 'done', batchCount: 1, batchesDone: [0] }))).toBe('Done: 1 batch');
    expect(jobStatusText(job({ status: 'done', batchCount: 0 }))).toBe('Done: no candidates to rank');
    expect(jobStatusText(job({ status: 'failed', message: 'The ranking stopped before it finished. Press Rank again.' }))).toBe(
      'The ranking stopped before it finished. Press Rank again.',
    );
    expect(jobStatusText(job({ status: 'failed' }))).toBe('The ranking failed. Press Rank again.');
    // A job whose generation guard failed twice (plan PR36).
    expect(jobStatusText(job({ status: 'failed', message: 'The ranking could not finish. Press Rank again.' }))).toBe(
      'The ranking could not finish. Press Rank again.',
    );
    expect(jobStatusText(job({ status: 'expired' }))).toBe('The ranking was not picked up. Press Rank again.');
  });

  it('counts CANDIDATES not scored, never a batch "failed" that mostly landed (plan PR42)', () => {
    // A failed call (two candidates), a partial match write (one candidate,
    // 'repo' - the call succeeded, so its batch is in BOTH batchesDone and
    // failedBatches) and an omission: 4 candidates.
    const lossy = job({
      status: 'done',
      batchCount: 3,
      batchesDone: [0, 2],
      failedBatches: [
        { index: 1, candidateIds: ['c2', 'c3'], failure: 'timeout' },
        { index: 2, candidateIds: ['c6'], failure: 'repo' },
      ],
      notScored: [{ candidateId: 'c4', reason: 'omitted' }],
    });
    expect(notScoredCount(lossy)).toBe(4);
    expect(jobStatusText(lossy)).toBe('Done: 3 batches; 4 candidates not scored. Press Rank again.');
    expect(jobStatusText(lossy)).not.toContain('failed');
    // A candidate listed twice is counted once.
    expect(
      notScoredCount(job({ failedBatches: [{ index: 1, candidateIds: ['c2'], failure: 'repo' }], notScored: [{ candidateId: 'c2', reason: 'omitted' }] })),
    ).toBe(1);
    // The job's own message (S5's copy), when it has one, replaces "Press Rank again.".
    const s5Message =
      '2 tenants could not be scored. Press Rank again. 1 tenant was not scored by the model. Press Rank again. ' +
      '1 score could not be saved. Press Rank again.';
    expect(jobStatusText({ ...lossy, message: s5Message })).toBe(`Done: 3 batches; 4 candidates not scored. ${s5Message}`);
    expect(
      jobStatusText(job({ status: 'running', batchCount: 2, batchesDone: [0], notScored: [{ candidateId: 'c4', reason: 'unreadable' }] })),
    ).toBe('Ranking: 1 of 2 batches finished; 1 candidate not scored');
  });

  it('an anchor that could not be read finishes with every candidate not scored and says why (plan PR38, PR43)', () => {
    const unreadable = (message: string) =>
      job({
        status: 'done',
        poolSize: 3,
        batchCount: 0,
        notScored: [
          { candidateId: 'u1', reason: 'unreadable' },
          { candidateId: 'u2', reason: 'unreadable' },
          { candidateId: 'u3', reason: 'unreadable' },
        ],
        message,
      });
    expect(jobStatusText(unreadable("Could not read this tenant's record. Press Rank again."))).toBe(
      "Done: 3 candidates not scored. Could not read this tenant's record. Press Rank again.",
    );
    expect(jobStatusText(unreadable("Could not read this property's record. Press Rank again."))).toBe(
      "Done: 3 candidates not scored. Could not read this property's record. Press Rank again.",
    );
  });

  it('counts FINISHED batches, scored or failed, by distinct index (plan review BB5)', () => {
    expect(finishedBatchCount(job())).toBe(0);
    expect(finishedBatchCount(job({ batchesDone: [0, 2] }))).toBe(2);
    expect(
      finishedBatchCount(
        job({
          batchesDone: [0],
          failedBatches: [
            { index: 1, candidateIds: ['a'], failure: 'timeout' },
            { index: 1, candidateIds: ['b'], failure: 'timeout' },
            // A partial match write (plan PR37): the call succeeded, so batch 0
            // is ALSO in batchesDone; it lists only the unwritten candidates.
            // Counted once - the de-dup is load-bearing.
            { index: 0, candidateIds: ['c'], failure: 'repo' },
          ],
        }),
      ),
    ).toBe(2);
  });

  it('marks a pair this run wrote, one re-scored since, and one with no match', () => {
    expect(currentMatchText('run-1', 'run-1')).toBe('This run');
    expect(currentMatchText('run-2', 'run-1')).toBe('Since re-scored');
    expect(currentMatchText(null, 'run-1')).toBe('No current match');
  });

  it('round-trips an anchor through its URL value and refuses a malformed one', () => {
    expect(anchorParam({ kind: 'unit', id: 'unit-1' })).toBe('unit:unit-1');
    expect(parseAnchorParam('tenant:contact-1')).toEqual({ kind: 'tenant', id: 'contact-1' });
    expect(parseAnchorParam('unit:a:b')).toEqual({ kind: 'unit', id: 'a:b' });
    expect(parseAnchorParam(null)).toBeUndefined();
    expect(parseAnchorParam('landlord:x')).toBeUndefined();
    expect(parseAnchorParam('unit:')).toBeUndefined();
    expect(parseAnchorParam('unit-1')).toBeUndefined();
  });
});
