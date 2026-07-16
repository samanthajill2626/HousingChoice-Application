// Static per-stage descriptor map driving the placement Now card.
//
// One row per stage in the PLACEMENT_STAGES ladder (imported from the shared
// constants — do NOT redeclare the ladder here). Each row answers three
// questions the Now card needs:
//   - gate:     whose move is it, and what is the single next action / who we
//               are waiting on. ('us' = staff must act; 'them' = we are blocked
//               on an external party; 'terminal' = no further action.)
//   - record:   what stage-specific datum the Now card lets staff record here
//               ('none' for stages that record nothing).
//   - gateDate: which date the gate line surfaces (resolved by the Now card).
//
// Copy is staff-facing, plain ASCII, "property" not "unit". `{tenant}` and
// `{landlord}` are literal placeholder tokens the Now card interpolates later.
import type { PlacementStage } from '../../api/index.js';

export type StageRecordKind =
  | 'none'
  | 'inspection_date'
  | 'inspection_review'
  | 'rent_determined'
  | 'accepted_rent'
  | 'paperwork';

export interface StageDescriptor {
  gate:
    | { kind: 'us'; move: string }
    | { kind: 'them'; waitingOn: string }
    | { kind: 'terminal' };
  record: StageRecordKind;
  // date the gate line shows, resolved by the Now card:
  gateDate: 'none' | 'inspection_date' | 'move_in_date' | 'stage_entered_at';
}

export const STAGE_DESCRIPTORS: Record<PlacementStage, StageDescriptor> = {
  send_application: {
    gate: { kind: 'us', move: 'Send the application packet to {tenant}' },
    record: 'none',
    gateDate: 'none',
  },
  awaiting_receipt: {
    gate: { kind: 'them', waitingOn: '{tenant} to confirm receipt of the application' },
    record: 'none',
    gateDate: 'stage_entered_at',
  },
  awaiting_completion: {
    gate: { kind: 'them', waitingOn: '{tenant} to complete the application' },
    record: 'none',
    gateDate: 'stage_entered_at',
  },
  awaiting_approval: {
    gate: { kind: 'them', waitingOn: '{landlord} to approve the application' },
    record: 'none',
    gateDate: 'stage_entered_at',
  },
  collect_rta: {
    gate: { kind: 'us', move: 'Collect the RTA from {tenant}' },
    record: 'none',
    gateDate: 'none',
  },
  review_rta: {
    gate: { kind: 'us', move: 'Review the RTA' },
    record: 'none',
    gateDate: 'none',
  },
  send_rta_to_landlord: {
    gate: { kind: 'us', move: 'Send the RTA to {landlord}' },
    record: 'none',
    gateDate: 'none',
  },
  awaiting_landlord_submission: {
    gate: { kind: 'them', waitingOn: '{landlord} to submit the RTA to the housing authority' },
    record: 'none',
    gateDate: 'stage_entered_at',
  },
  awaiting_authority_approval: {
    gate: { kind: 'them', waitingOn: 'the housing authority to approve the RTA' },
    record: 'none',
    gateDate: 'stage_entered_at',
  },
  schedule_inspection: {
    gate: { kind: 'us', move: 'Schedule the inspection' },
    record: 'inspection_date',
    gateDate: 'none',
  },
  awaiting_inspection: {
    gate: { kind: 'them', waitingOn: 'the housing authority inspection' },
    record: 'inspection_review',
    gateDate: 'inspection_date',
  },
  determine_rent: {
    gate: { kind: 'them', waitingOn: 'the housing authority to determine rent' },
    record: 'rent_determined',
    gateDate: 'stage_entered_at',
  },
  awaiting_rent_acceptance: {
    gate: { kind: 'them', waitingOn: '{landlord} to accept the determined rent' },
    record: 'accepted_rent',
    gateDate: 'stage_entered_at',
  },
  awaiting_hap_contract: {
    gate: { kind: 'them', waitingOn: 'the housing authority HAP contract' },
    record: 'none',
    gateDate: 'stage_entered_at',
  },
  complete_paperwork: {
    gate: { kind: 'us', move: 'Finish the closing checklist' },
    record: 'paperwork',
    gateDate: 'none',
  },
  awaiting_move_in: {
    gate: { kind: 'them', waitingOn: 'move-in day' },
    record: 'none',
    gateDate: 'stage_entered_at',
  },
  moved_in: {
    gate: { kind: 'terminal' },
    record: 'none',
    gateDate: 'none',
  },
  lost: {
    gate: { kind: 'terminal' },
    record: 'none',
    gateDate: 'none',
  },
};
