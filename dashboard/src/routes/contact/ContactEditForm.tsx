// ContactEditForm - the edit dialog for a contact's details. Type + role are
// editable via the SAME KindPicker the create dialog uses, but kept collapsed
// behind a "Change type" button (retyping a contact is rare) so the common edit
// stays compact. The resolved kind drives the type-aware fields: name + status +
// notes for everyone, voucher size for tenants, company for landlords/PMs, plus
// Relationships + Custom fields. Dirty-tracked: only the changed fields are
// PATCHed (the server SET-merges, so an untouched field is never blanked) -
// switching type leaves the other type's old fields on the record (harmless; they
// just stop showing). On success the parent applies the returned contact in place.
import { useEffect, useId, useRef, useState } from 'react';
import {
  ApiError,
  setTenantStatus,
  statusOptionsFor,
  updateContact,
  type Address,
  type Contact,
  type ContactPatch,
  type ContactStatusValue,
  type Relationship,
  type CustomField,
  type ContactType,
  type OrgRef,
} from '../../api/index.js';

// The valid status values and labels per contact type come from the ONE shared
// mirror of the backend status model (api/types.ts statusOptionsFor, spec
// 2026-10-23 D3) - the same list the contact page header dropdown offers. This
// form keeps no list of its own.

/** The valid status values for a type, in dropdown order. */
function validStatusesForType(type: ContactType): readonly string[] {
  return statusOptionsFor(type).map((o) => o.value);
}

/** The status the field starts on for a type, given the contact's stored
 *  status: the stored value when it is legal for the type, else the type's
 *  front door ('needs_review'). Never surfaces an off-list value as a
 *  selectable option. */
function defaultStatusForType(type: ContactType, storedStatus: string): string {
  return validStatusesForType(type).includes(storedStatus) ? storedStatus : 'needs_review';
}

/** The status a TYPE CHANGE moves the field to (spec 2026-10-23 D3): the new
 *  type's first step - the same values the server writes for a type change
 *  with no explicit status (D7). Staff may pick another before saving. */
const FIRST_STATUS_FOR_TYPE: Readonly<Record<ContactType, ContactStatusValue>> = {
  tenant: 'onboarding',
  landlord: 'interested',
  partner: 'active',
  team_member: 'active',
  unknown: 'needs_review',
};
import { Button } from '../../ui/index.js';
import { consentAtFromDate } from '../../lib/consentCopy.js';
import { typeChangeRefusalsFrom, type TypeChangeRefusal } from '../../lib/holdingRefusals.js';
import { RelationshipsEditor } from './RelationshipsEditor.js';
import { CustomFieldsEditor } from './CustomFieldsEditor.js';
import { KindPicker, type KindPickerValue } from './KindPicker.js';
import { TypeChangeRefusalList } from './TypeChangeRefusalList.js';
import { isCaseworkerContact } from './caseworkerRole.js';
import { useContactVocabulary } from './useContactVocabulary.js';
import {
  TENANT_MATCHING_INPUTS,
  buildTenantMatchingPatch,
  tenantMatchingFormValues,
} from './tenantMatchingInputs.js';
import { NewOrgDialog } from '../orgs/NewOrgDialog.js';
import { OrgPicker, type OrgPickerHandle } from '../orgs/OrgPicker.js';
import {
  AGENCY_KINDS,
  HOUSING_AUTHORITY_KINDS,
  ORGANIZATION_KINDS,
  isOrgFormField,
  newOrgDialogKind,
  orgPickField,
  type OrgFormField,
  notOnListMessage,
  orgListLoadError,
  orgListUnknown,
  orgNotOnListBody,
  refusesSave,
} from '../orgs/orgCopy.js';
import { useOrgList } from '../orgs/useOrgList.js';
import { useTypedOrgText } from '../orgs/useTypedOrgText.js';
import {
  CONTACT_TYPE_LABEL,
  normalizeRelationships,
  normalizeCustomFields,
} from './contactProfile.js';
import { Modal } from './Modal.js';
import { LANDLORD_ONBOARDING_HINTS } from './landlordOnboarding.js';
import { FlyerLegend } from '../listing/FlyerTag.js';
import { RequirementsFields } from '../listing/RequirementsFields.js';
import {
  buildRequirementPatch,
  requirementFormValuesFromLandlord,
  toLandlordPatch,
  type RequirementFormValues,
} from '../listing/requirementForm.js';
import styles from './ContactEditForm.module.css';

/** The PATCH refuses a save whose result would make this contact a caseworker
 *  (409 caseworker_use_conversion, spec D16): the conversion is the only way.
 *  Reachable only from a stale form - the offer gate below hides the choice. */
export const CASEWORKER_USE_CONVERSION = 'To make this contact a caseworker, use More actions > Make caseworker.';

/** Ruling AR32 (property requirements D1): a landlord save the server refuses
 *  with 400 deposit_conflict - the resulting record would hold both a
 *  one-month deposit and a fixed amount (a colleague's save landed first). */
export const DEPOSIT_CONFLICT_COPY =
  "A deposit can be one month's rent or a fixed amount, not both. Reload the landlord and try again.";

/** Code review R1 FW1-1 (docblock corrected in R2 FW2-2 and R3 FW3-1): the
 *  save's status write answered 409 contact_type_changed - the stored type is
 *  no longer the one this form's Status list was built for (`statusType`: the
 *  type as opened, or the type the draft changed it to) because a colleague
 *  re-typed the contact, so the route wrote no status. It claims nothing about
 *  the other fields: a field PATCH that ran first may have saved them (a
 *  draft's type change included), or there was none. The form then disables
 *  Save for this opening: a retry would send the same expectedType into
 *  another 409 or, for a draft that changed the type, re-send that type in
 *  the field PATCH - which has no type fence - over the colleague's re-type,
 *  and its status write would then succeed. It also calls `onStale`, on which
 *  the contact page re-reads the contact (a consistent read) and shows it, so
 *  the form opened next is built from the stored contact - the new type's
 *  Status list, and whatever the PATCH saved - even when no contact.updated
 *  reached the page. That read is best-effort; when it fails, the copy's
 *  reload is the way to a fresh read. */
export const CONTACT_TYPE_CHANGED_SAVE_COPY =
  "This contact's type changed while you were editing, so its status was not saved. Reload the contact to pick a status for its new type.";

/** WP1 B2a spec D14.3: a save refused 409 notes_stale - the Notes box was
 *  written (by a colleague, extraction or the importer) since the form
 *  opened, and the PATCH stored nothing. The Staff notes card's wording for
 *  this form; "Nothing was saved." first (plan S1 C6). */
export const NOTES_STALE_COPY =
  'Nothing was saved. These notes were changed since you opened this form. The current notes are below, and your text is still in the box. Save again to replace them, or Cancel to keep them.';

/** The current contact a 409 notes_stale carries, or null for any other
 *  failure (StaffNotesCard.tsx staleContact's rule). */
function staleNotesContact(err: unknown): Contact | null {
  if (!(err instanceof ApiError) || err.status !== 409 || err.code !== 'notes_stale') return null;
  const body = err.body;
  if (typeof body !== 'object' || body === null) return null;
  const current = (body as { contact?: unknown }).contact;
  return typeof current === 'object' && current !== null ? (current as Contact) : null;
}

export interface ContactEditFormProps {
  contact: Contact;
  onClose: () => void;
  onSaved: (updated: Contact) => void;
  /** Called when the save's status write answers 409 contact_type_changed:
   *  the contact this form was opened on is stale (code review R3 FW3-1).
   *  The contact page re-reads it, as for its header's own 409. */
  onStale?: () => void;
  /** Receives the current contact a 409 notes_stale carries (WP1 B2a code
   *  review R1 A2-5, R2 FW2-4), as the Staff notes card hands its refusal's
   *  contact up: the page applies it in place at once, so "Cancel to keep
   *  them" leaves the page on the current notes and the next edit opens from
   *  them. The form stays open. */
  onContactUpdated?: (current: Contact) => void;
  candidates?: Contact[];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function ContactEditForm({
  contact,
  onClose,
  onSaved,
  onStale,
  onContactUpdated,
  candidates = [],
}: ContactEditFormProps): React.JSX.Element {
  const vocab = useContactVocabulary();

  // The stored organization lists behind the two tenant pickers (spec
  // 2026-10-06 D6), read on every mount (no client cache, spec D1).
  const orgList = useOrgList();
  // "Is this really new?" - opened by a picker's add option and rendered after
  // the </form>, so nothing in it can submit this form (R5 ruling).
  // Keyed by the FIELD whose picker opened it (R2-F8).
  const [adding, setAdding] = useState<{ field: OrgFormField; text: string } | null>(null);
  // A refused save's message (422 org_not_on_list), shown under its picker.
  const [orgFieldError, setOrgFieldError] = useState<{
    field: OrgFormField;
    message: string;
  } | null>(null);
  // Text typed in a picker but never picked (code review R1-ADV-FE-1, R2-FE-6):
  // never dropped silently. One rule (useTypedOrgText) writes the note under
  // each picker and decides Save: text naming exactly one entry is committed
  // as a pick would be; any other text refuses the save, saying why under
  // that picker.
  const housingAuthorityPicker = useRef<OrgPickerHandle>(null);
  const agencyPicker = useRef<OrgPickerHandle>(null);
  const housingAuthorityText = useTypedOrgText(orgList, HOUSING_AUTHORITY_KINDS, housingAuthorityPicker);
  const agencyText = useTypedOrgText(orgList, AGENCY_KINDS, agencyPicker);
  const organizationPicker = useRef<OrgPickerHandle>(null);
  const organizationText = useTypedOrgText(orgList, ORGANIZATION_KINDS, organizationPicker);

  // The contact AS OPENED (plan round 2 R2P-1). Every "did the user change
  // this?" comparison - buildPatch, onSubmit, typeChanged, initialStatus,
  // statusType - reads `base`, never the live `contact` prop: the page
  // re-reads the open contact on contact.updated (S2.9) and passes the new
  // one in, and diffing a stale draft against it would write another
  // operator's concurrent change back. Identity and display-only reads stay
  // on the live prop.
  const [base] = useState(contact);
  // Type + role together - a KindPicker value, kept collapsed behind "Change type"
  // (changingType) since retyping is rare. isTenant/isLandlord derive from the
  // LIVE kind so the type-specific fields swap the moment the base type changes.
  const [kind, setKind] = useState<KindPickerValue>({
    type: contact.type,
    role: str(contact.role),
  });
  const [changingType, setChangingType] = useState(false);
  // A refused type change's blocking records (409 type_change_refused, spec
  // 2026-10-12 D2), shown beside the kind picker until the kind changes or
  // the next save.
  const [typeRefusals, setTypeRefusals] = useState<TypeChangeRefusal[] | null>(null);
  const isLandlord = kind.type === 'landlord';
  const isTenant = kind.type === 'tenant';
  // Partners (caseworkers included) edit their organization (spec D17).
  const isPartner = kind.type === 'partner';
  // The live base type for status scoping (KindPicker may be momentarily null
  // mid-change; fall back to the stored type).
  const liveType: ContactType = kind.type ?? base.type;
  // Spec 2026-10-23 D3: a TYPE change is measured against the STORED type - the
  // picker left on a different base type at save time. A role-only switch
  // inside one type and a change-and-back are not type changes. Stored = as
  // OPENED (`base`, step 3j, plan round 2 R2P-1).
  const typeChanged = kind.type !== null && kind.type !== base.type;
  // The stored status as the field first shows it (an off-list stored value
  // reads as the type's front door).
  const initialStatus = defaultStatusForType(base.type, str(base.status));
  // The type the Status field was last derived for (plan round 1 P1). Not
  // liveType: the KindPicker's Other panel passes through type null, where
  // liveType falls back to the STORED type, so a stored -> other -> Other ->
  // stored round trip would look like no change and keep the other type's
  // first step.
  const [statusType, setStatusType] = useState<ContactType>(base.type);

  const [firstName, setFirstName] = useState(str(contact.firstName));
  const [lastName, setLastName] = useState(str(contact.lastName));
  // The status selection is ALWAYS valid for the current type. Seed it from the
  // stored status, defaulting off-list values to the type's front door (so a
  // legacy tenant stored as 'active' starts on 'needs_review', never on the
  // off-list 'active'). A type change re-derives it (see the effect below).
  const [status, setStatus] = useState(() =>
    defaultStatusForType(contact.type, str(contact.status)),
  );
  const [porting, setPorting] = useState(contact.porting === true);
  const [notes, setNotes] = useState(str(contact.notes));
  // WP1 B2a spec D14.3: the Notes stale-save guard (StaffNotesCard.tsx's
  // pattern). The Notes box's own baseline - its text and the
  // notes_updated_at the form OPENED with (null = never stamped) - kept
  // apart from `base`: a 409 notes_stale re-bases it on the current contact
  // while every other field still diffs against `base`.
  const [notesBaseline, setNotesBaseline] = useState<{ text: string; stamp: string | null }>(() => ({
    text: str(contact.notes),
    stamp: typeof contact.notes_updated_at === 'string' ? contact.notes_updated_at : null,
  }));
  // The current notes a notes_stale refusal carried (null = no conflict),
  // shown beside the box until a save lands or the form closes.
  const [notesConflict, setNotesConflict] = useState<string | null>(null);
  // Counts refusals; the focus effect keys on it, so a second refusal with
  // the same notes refocuses too.
  const [notesRefusals, setNotesRefusals] = useState(0);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const notesConflictId = useId();
  // After a refusal, focus the box: the user's text is there and its
  // aria-describedby now names the conflict panel. An effect, not a focus()
  // in the handler, so the description is attached before focus lands.
  useEffect(() => {
    if (notesRefusals > 0) notesRef.current?.focus();
  }, [notesRefusals]);
  const [voucher, setVoucher] = useState(
    typeof contact.voucherSize === 'number' ? String(contact.voucherSize) : '',
  );
  // Tenant-only voucher expiration DATE. Stored as an ISO instant; the date input
  // needs YYYY-MM-DD, so seed from the stored ISO's date part.
  const [voucherExpiration, setVoucherExpiration] = useState(
    str(contact.voucher_expiration_date).slice(0, 10),
  );
  const [company, setCompany] = useState(str(contact['company']));
  // Landlord onboarding deal terms + approval criteria (edit form). contract_status
  // as a select (''=unset); the four criteria as booleans; park_reason as free
  // text. (Preferences + expected rent moved to the UNIT, 2026-07-10 — edit them
  // on the property.)
  const [contractStatus, setContractStatus] = useState(str(contact.contract_status));
  const [registeredLandlord, setRegisteredLandlord] = useState(contact.registered_landlord === true);
  const [rtaWithin48h, setRtaWithin48h] = useState(contact.rta_within_48h === true);
  const [passInspection, setPassInspection] = useState(contact.pass_inspection_first_try === true);
  const [incomeIncludesVoucher, setIncomeIncludesVoucher] = useState(
    contact.income_includes_voucher === true,
  );
  const [parkReason, setParkReason] = useState(str(contact.park_reason));
  // Property requirements D9: the landlord's requirements as form values keyed
  // by UNIT key (S5's requirementForm.ts maps the req_ keys in with
  // requirementFormValuesFromLandlord, and toLandlordPatch maps the changed
  // ones back out).
  const [requirements, setRequirements] = useState<RequirementFormValues>(() =>
    requirementFormValuesFromLandlord(contact),
  );
  const [housingAuthority, setHousingAuthority] = useState(str(contact.housingAuthority));
  // The helper organization a tenant works with - a DIFFERENT dimension from the
  // authority that runs the voucher (two lists, spec 2026-10-06 D1).
  const [agency, setAgency] = useState(str(contact.agency));
  // A partner's organization (spec D17) - one list name of either kind.
  const [organization, setOrganization] = useState(str(contact.organization));

  /** Each org field has its own setter (R2-F8). */
  const orgSetters: Record<OrgFormField, (name: string) => void> = {
    housingAuthority: setHousingAuthority,
    agency: setAgency,
    organization: setOrganization,
  };

  /** Put a list name where an answer for `field`'s picker belongs
   *  (orgPickField): a tenant field follows the name's KIND - "Is this
   *  really new?" can answer with the other kind ("Put it in Agency") - and
   *  an organization keeps a name of either kind. */
  function applyOrg(field: OrgFormField, ref: OrgRef): void {
    orgSetters[orgPickField(field, ref)](ref.name);
    setOrgFieldError(null);
  }
  const [pets, setPets] = useState(str(contact['pets']));
  const [evictions, setEvictions] = useState(str(contact['evictions']));
  const [tenure, setTenure] = useState(str(contact['tenure']));
  const [lifEligible, setLifEligible] = useState(contact['lifEligible'] === true);
  // WP1 B1 (spec D2): the tenant matching inputs, one value per entry of the
  // mirror list (tenantMatchingInputs.ts) - this form names none of the four.
  const [matching, setMatching] = useState<Record<string, string>>(() => tenantMatchingFormValues(contact));
  const matchingId = useId();
  // WP1 B1 FW-11 (code review R1 CONF-1): the dollars controls' DOM nodes,
  // read at Save. DEFENSE IN DEPTH only (WP1 B1 FW2-2, code review R2-2): this
  // form sets no `noValidate`, so in a browser native validation refuses an
  // entry the number input cannot parse (its value reads '' with
  // `validity.badInput` set) with the browser's own message (Chromium:
  // "Please enter a number.") before Save runs - no role="alert", no request.
  // Only a form or test that skips native validation gets here, where
  // `validity.badInput` alone tells such an entry from a cleared control
  // (React fires no change for it). Parseable bad values (12.5, -5, 20001) do
  // reach Save and show the server's copy in the form's role="alert".
  const dollarsInputs = useRef(new Map<string, HTMLInputElement>());
  const [relRows, setRelRows] = useState<Relationship[]>(contact.relationships ?? []);
  const [cfRows, setCfRows] = useState<CustomField[]>(contact.customFields ?? []);
  // Track whether the editors have been expanded (start collapsed to keep the
  // form clean when there is no pre-existing data).
  const [showRelationships, setShowRelationships] = useState(
    (contact.relationships ?? []).length > 0,
  );
  const [showCustomFields, setShowCustomFields] = useState(
    (contact.customFields ?? []).length > 0,
  );

  // Spec 2026-10-23 D3: a change of BASE type moves the Status field to the new
  // type's first step (tenant Onboarding, landlord Interested, partner Active);
  // coming back to the STORED type shows the stored status again (a
  // change-and-back is not a change). A role-only switch inside one type
  // (Landlord to the Property Manager preset) and the Other panel's base-less
  // step (type null) leave the field alone. "A change of base type" is
  // measured against statusType - the type the field was last derived for -
  // so picking a base through Other still re-derives (plan round 1 P1).
  function handleKindChange(next: KindPickerValue): void {
    setKind(next);
    setTypeRefusals(null);
    if (next.type !== null && next.type !== statusType) {
      setStatus(next.type === base.type ? initialStatus : FIRST_STATUS_FOR_TYPE[next.type]);
      setStatusType(next.type);
    }
    // A type that is not tenant unmounts the tenant pickers, and the text typed
    // in them goes with them (an unmounted OrgPicker reports '').
  }

  function handleShowRelationships(): void {
    setShowRelationships(true);
    if (relRows.length === 0) setRelRows([{ role: '', name: '' }]);
  }

  function handleShowCustomFields(): void {
    setShowCustomFields(true);
    if (cfRows.length === 0) setCfRows([{ label: '', value: '' }]);
  }
  // Initial address parts (a structured object, or a legacy string folded into line1).
  const addrObj: Partial<Address> =
    typeof base.address === 'object' && base.address !== null ? base.address : {};
  const initAddr = {
    line1: str(addrObj.line1) || (typeof base.address === 'string' ? base.address : ''),
    line2: str(addrObj.line2),
    city: str(addrObj.city),
    state: str(addrObj.state),
    zip: str(addrObj.zip),
  };
  const [line1, setLine1] = useState(initAddr.line1);
  const [line2, setLine2] = useState(initAddr.line2);
  const [city, setCity] = useState(initAddr.city);
  const [stateField, setStateField] = useState(initAddr.state);
  const [zip, setZip] = useState(initAddr.zip);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Code review R2 FW2-2: a save's status write answered 409
  // contact_type_changed. Save then stays off for this opening (closing
  // unmounts the form; R3 FW3-1: the page re-reads the contact on onStale, so
  // the next opening is built from the stored contact) - see
  // CONTACT_TYPE_CHANGED_SAVE_COPY.
  const [retypedUnderForm, setRetypedUnderForm] = useState(false);

  // Build the PATCH from only the fields the user actually changed. `org` is
  // the org fields as Save settled them (settleTypedText).
  function buildPatch(org: {
    housingAuthority: string;
    agency: string;
    organization: string;
  }): ContactPatch | { error: string } {
    const patch: ContactPatch = {};
    // Type + role from the KindPicker (kind.type is non-null whenever Save is
    // enabled). A cleared role sends '' (the server clears it).
    if (kind.type !== null && kind.type !== base.type) patch.type = kind.type;
    const roleTrimmed = kind.role.trim();
    if (roleTrimmed !== str(base.role).trim()) patch.role = roleTrimmed;

    if (firstName !== str(base.firstName)) patch.firstName = firstName;
    if (lastName !== str(base.lastName)) patch.lastName = lastName;
    // Status in THIS PATCH (spec 2026-10-23 D3) - only two cases:
    //  - a type change to a NON-tenant: the shown status, ALWAYS, explicitly
    //    (the server honors it over its own type-change default);
    //  - a landlord with no type change, when the status changed: its park
    //    reason rides this PATCH too, and the transition plan overwrites
    //    park_reason on every move to parked, so the landlord status stays
    //    here. Compared against the initial VALID selection, so an off-list
    //    stored value does not masquerade as a no-op change.
    // A tenant (stored or target) never sends status here - setTenantStatus
    // applies provenance/derivation; a partner, team member or unknown contact
    // with no type change sends it through setTenantStatus too (onSubmit), as
    // the header dropdown does.
    if (typeChanged) {
      if (!isTenant) patch.status = status;
    } else if (isLandlord && status !== initialStatus) {
      patch.status = status;
    }
    // WP1 B2a D14.3: the Notes box diffs against ITS baseline (re-based by a
    // notes_stale refusal). The trim only decides whether the box changed (a
    // whitespace-only edit is no change); the PATCH sends `notes` as typed and
    // the server stores it as sent. Every save that sends notes sends the
    // stamp that baseline holds.
    if (notes.trim() !== notesBaseline.text.trim()) {
      patch.notes = notes;
      patch.notes_expected_updated_at = notesBaseline.stamp;
    }
    if (isLandlord && company !== str(base['company'])) patch.company = company;

    // Landlord onboarding deal terms + approval criteria — dirty-tracked, only the
    // changed fields ride the PATCH (the server SET-merges). (Preferences +
    // expected rent moved to the UNIT, 2026-07-10.)
    if (isLandlord) {
      if (contractStatus !== str(base.contract_status) && contractStatus !== '') {
        patch.contract_status = contractStatus === 'signed' ? 'signed' : 'unsigned';
      }
      if (registeredLandlord !== (base.registered_landlord === true)) {
        patch.registered_landlord = registeredLandlord;
      }
      if (rtaWithin48h !== (base.rta_within_48h === true)) {
        patch.rta_within_48h = rtaWithin48h;
      }
      if (passInspection !== (base.pass_inspection_first_try === true)) {
        patch.pass_inspection_first_try = passInspection;
      }
      if (incomeIncludesVoucher !== (base.income_includes_voucher === true)) {
        patch.income_includes_voucher = incomeIncludesVoucher;
      }
      if (parkReason !== str(base.park_reason)) patch.park_reason = parkReason;
      // D9: only the req_ keys that changed - and, on the save that CHECKS One
      // month's rent, req_deposit null (D1; buildRequirementPatch adds it) - by
      // the same helper the property forms use, so the two cannot drift.
      // Gated on the LIVE kind: a contact retyped away from landlord sends no
      // req_ key (the server refuses them).
      const req = buildRequirementPatch(requirementFormValuesFromLandlord(base), requirements);
      // Defensive: the amount inputs' min={0} stops a bad amount at native
      // validation first; ok: false is pinned in requirementForm.test.ts (S5 Task 5.3).
      if (!req.ok) return { error: req.error };
      Object.assign(patch, toLandlordPatch(req.patch));
    }

    // Relationships - only send if the normalized form changed.
    const normRel = normalizeRelationships(relRows);
    const initRel = normalizeRelationships(base.relationships ?? []);
    if (JSON.stringify(normRel) !== JSON.stringify(initRel)) patch.relationships = normRel;

    // Custom fields - only send if the normalized form changed.
    const normCf = normalizeCustomFields(cfRows);
    const initCf = normalizeCustomFields(base.customFields ?? []);
    if (JSON.stringify(normCf) !== JSON.stringify(initCf)) patch.customFields = normCf;

    if (isTenant) {
      const initialVoucher = typeof base.voucherSize === 'number' ? String(base.voucherSize) : '';
      if (voucher !== initialVoucher) {
        if (voucher === '') {
          // Leave voucher untouched rather than send a blank (the server expects a
          // 0..12 integer); clearing a voucher isn't a supported edit.
        } else {
          const n = Number(voucher);
          if (!Number.isInteger(n) || n < 0 || n > 12) {
            return { error: 'Voucher size must be a whole number from 0 to 12.' };
          }
          patch.voucherSize = n;
        }
      }
      // Voucher expiration: dirty-tracked on the YYYY-MM-DD date part. A cleared
      // value sends null (the server retires the voucher deadline); a set value is
      // canonicalized to an ISO instant.
      const initialVoucherExp = str(base.voucher_expiration_date).slice(0, 10);
      if (voucherExpiration !== initialVoucherExp) {
        patch.voucher_expiration_date =
          voucherExpiration.trim() === '' ? null : consentAtFromDate(voucherExpiration.trim());
      }
      // Housing authority + agency (spec 2026-10-06 D6): the pickers change a
      // field only by a pick (an exact list name) or a removed chip (''), so
      // the comparison is exact - an untouched field still holds the stored
      // text byte for byte, whatever it is.
      //
      // `housingAuthority` is a server-side PROVENANCE field, and the server
      // builds `changedFields` from key PRESENCE alone: merely INCLUDING the key
      // in the PATCH body nulls `housingAuthority_source`, consumes (deletes) any
      // pending AI suggestion for the field and stamps its ai_run
      // `superseded_by_human_edit` - whatever the value. An untouched field
      // must never reach the wire, which also means a stored value that is not
      // on the list is never refused for being unchanged (D5). Typed text Save
      // committed (R1-ADV-FE-1) is an exact list name too, so a name equal to
      // the stored one stays off the wire.
      if (org.housingAuthority !== str(base.housingAuthority)) {
        patch.housingAuthority = org.housingAuthority;
      }
      if (org.agency !== str(base.agency)) {
        patch.agency = org.agency;
      }
      if (pets !== str(base['pets'])) patch.pets = pets;
      if (evictions !== str(base['evictions'])) patch.evictions = evictions;
      if (tenure !== str(base['tenure'])) patch.tenure = tenure;
      if (lifEligible !== (base['lifEligible'] === true)) patch.lifEligible = lifEligible;
      // WP1 B1 (spec D2): only the changed matching inputs, trimmed; a
      // cleared one sends null (the server REMOVEs it). A bad value stops the
      // save with the server's own copy (the mirror drift test pins it). An
      // entry its number input could not parse is refused here too (FW-11),
      // though in a browser native validation refuses it first (WP1 B1 FW2-2).
      const unparseable = new Set(
        [...dollarsInputs.current].filter(([, el]) => el.validity?.badInput === true).map(([key]) => key),
      );
      const matchingPatch = buildTenantMatchingPatch(matching, base, unparseable);
      if (!matchingPatch.ok) return { error: matchingPatch.error };
      Object.assign(patch, matchingPatch.patch);
      // Address: if ANY part changed, send the whole object (the server keeps only
      // the non-empty parts).
      if (
        line1 !== initAddr.line1 ||
        line2 !== initAddr.line2 ||
        city !== initAddr.city ||
        stateField !== initAddr.state ||
        zip !== initAddr.zip
      ) {
        patch.address = { line1, line2, city, state: stateField, zip };
      }
    }
    // A partner's organization (spec D17): changed only by a pick, a removed
    // chip ('' - the server REMOVEs it) or committed typed text, so the
    // comparison is exact and an untouched value - on the list or not - never
    // reaches the wire (D5).
    if (isPartner && org.organization !== str(base.organization)) {
      patch.organization = org.organization;
    }
    return patch;
  }

  /**
   * Code review R1-ADV-FE-1: text typed in a tenant picker but never picked is
   * never dropped silently. Both pickers' text is settled by the one rule
   * (useTypedOrgText): text naming exactly one entry is committed as a pick
   * would be - even when the other picker refuses; any other text refuses the
   * save, says why under its picker and the first refused picker takes focus.
   * Returns the org field values to save, or null when the save is
   * refused. (An Enter in a picker with nothing highlighted submits the form,
   * so it lands here too.)
   */
  function settleTypedText(): { housingAuthority: string; agency: string; organization: string } | null {
    const org = { housingAuthority, agency, organization };
    if (isPartner) {
      // The partner's one picker, settled by the same rule (R4-07).
      const og = organizationText.settle();
      if (og.status === 'resolved') {
        org.organization = og.name;
        setOrganization(og.name);
        setOrgFieldError(null);
      }
      if (refusesSave(og)) {
        organizationText.focus();
        return null;
      }
      return org;
    }
    if (!isTenant) return org;
    const ha = housingAuthorityText.settle();
    const ag = agencyText.settle();
    if (ha.status === 'resolved') {
      org.housingAuthority = ha.name;
      setHousingAuthority(ha.name);
    }
    if (ag.status === 'resolved') {
      org.agency = ag.name;
      setAgency(ag.name);
    }
    // A commit clears a refused-save message the way a pick does.
    if (ha.status === 'resolved' || ag.status === 'resolved') setOrgFieldError(null);
    if (refusesSave(ha)) housingAuthorityText.focus();
    else if (refusesSave(ag)) agencyText.focus();
    return refusesSave(ha) || refusesSave(ag) ? null : org;
  }

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    // retypedUnderForm: a submit by another route (Enter in a field) is as
    // closed as the disabled Save button.
    if (saving || retypedUnderForm) return;
    const org = settleTypedText();
    if (org === null) return; // refused: the picker says why
    const result = buildPatch(org);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    // The status write that does NOT ride the PATCH goes through the transition
    // service (setTenantStatus serves every type; spec 2026-10-23 D3):
    //  - a tenant with no type change: a status or porting change (unchanged);
    //  - a type change TO tenant: the PATCH never carries a tenant status and
    //    the server auto-advances to Onboarding, so only a different shown
    //    status (or a porting change - porting is only writable here) needs
    //    this second write; the default case writes ONE milestone, not two;
    //  - a partner, team member or unknown contact with no type change: a
    //    status change, exactly as the header dropdown writes it.
    // Compared against the initial VALID selection (a legacy off-list value
    // was normalized to 'needs_review' on load).
    const portingChanged = porting !== (base.porting === true);
    const statusTransition = typeChanged
      ? isTenant && (status !== 'onboarding' || portingChanged)
      : isTenant
        ? status !== initialStatus || portingChanged
        : !isLandlord && status !== initialStatus;

    if (Object.keys(result).length === 0 && !statusTransition) {
      onClose(); // nothing changed
      return;
    }
    setSaving(true);
    setError(null);
    setTypeRefusals(null);
    try {
      // Field edits (name, notes, voucher, address, -) ride the plain PATCH.
      let updated: Contact = contact;
      if (Object.keys(result).length > 0) {
        updated = await updateContact(contact.contactId, result);
        // Plan review FB8: a PATCH that carried notes has STORED them, so the
        // Notes baseline (text and stamp) moves to its answer before any later
        // write - the status write below may still fail and leave the form
        // open, and the next Save must not meet a false notes_stale about the
        // user's own save. ONLY then: a PATCH without notes must never adopt a
        // stamp the user has not seen (the next Save would overwrite lines
        // written since the form opened without a conflict).
        if ('notes' in result) {
          setNotesBaseline({
            text: str(updated.notes),
            stamp: typeof updated.notes_updated_at === 'string' ? updated.notes_updated_at : null,
          });
          setNotesConflict(null);
        }
      }
      // The transition-service write (see statusTransition above), AFTER the
      // PATCH so a type change lands first. The returned contact supersedes the
      // PATCH's. toStatus is kept in the live type's list by the select, but
      // narrow defensively - never send an unchecked value; fall back to the
      // front door if somehow off-list. Porting rides only a tenant's write.
      if (statusTransition) {
        const toStatus = (
          validStatusesForType(liveType).includes(status) ? status : 'needs_review'
        ) as ContactStatusValue;
        updated = await setTenantStatus(contact.contactId, {
          toStatus,
          source: 'manual',
          // Code review R1 FW1-1: the type the Status list was built for
          // (statusType equals kind.type whenever Save is enabled; `base`'s
          // type unless the picker changed it). A contact re-typed since the
          // form opened is a 409, never a status from the old list.
          expectedType: statusType,
          ...(isTenant && { porting }),
        });
      }
      onSaved(updated);
    } catch (err) {
      // A refused org value (422 org_not_on_list, spec D5) names its field:
      // say why under that picker, from the body - never the raw code.
      const refused = orgNotOnListBody(err);
      const currentNotes = staleNotesContact(err);
      if (refused !== null && isOrgFormField(refused.field)) {
        setOrgFieldError({ field: refused.field, message: notOnListMessage(refused) });
      } else if (currentNotes !== null) {
        // WP1 B2a D14.3: the Notes box was written since this form opened,
        // and the PATCH stored nothing (the status write never ran). Keep
        // every typed field; show the current notes beside the box; re-base
        // the Notes baseline on them, so the next Save is a deliberate
        // overwrite of notes the user has now seen, and Cancel keeps them.
        const theirText = str(currentNotes.notes);
        setNotesBaseline({
          text: theirText,
          stamp: typeof currentNotes.notes_updated_at === 'string' ? currentNotes.notes_updated_at : null,
        });
        setNotesConflict(theirText);
        setNotesRefusals((n) => n + 1);
        // Code review R1 A2-5, R2 FW2-4: the page under the form still shows
        // the notes it read, so hand it the current contact this 409 carries
        // (the Staff notes card's pattern): "Cancel to keep them" then leaves
        // it on the current notes, and the next edit opens from them. Handed
        // up at once, not re-read, so no late answer can land over the user's
        // own next save.
        onContactUpdated?.(currentNotes);
      } else if (err instanceof ApiError && err.status === 409 && err.code === 'caseworker_use_conversion') {
        // A save never makes a contact a caseworker (spec D16) - say where to go.
        setError(CASEWORKER_USE_CONVERSION);
      } else if (err instanceof ApiError && err.status === 400 && err.code === 'deposit_conflict') {
        // AR32: say why, and keep the form open with what staff typed - never
        // the generic save error below.
        setError(DEPOSIT_CONFLICT_COPY);
      } else if (err instanceof ApiError && err.status === 409 && err.code === 'contact_type_changed') {
        // FW1-1: the status write found the stored type is no longer the one
        // this form's Status list was built for (a colleague re-typed the
        // contact), so it wrote nothing. Say so; keep the draft. FW2-2: and
        // turn Save off until the form is reopened. R3 FW3-1: and tell the
        // page, which re-reads the contact (see the copy's docblock).
        setError(CONTACT_TYPE_CHANGED_SAVE_COPY);
        setRetypedUnderForm(true);
        onStale?.();
      } else {
        // A type change that would orphan open records (spec 2026-10-12 D2):
        // keep the draft and show what blocks it beside the kind picker.
        const typeRefused = typeChangeRefusalsFrom(err);
        if (typeRefused !== null) setTypeRefusals(typeRefused);
        else setError("Couldn't save - please try again.");
      }
      setSaving(false);
    }
  }

  // The current saved kind, shown in the collapsed summary: role (custom kind) +
  // its base record type, else just the base type label.
  const savedRole = str(base.role).trim();
  const currentKindLabel = savedRole
    ? `${savedRole} - ${CONTACT_TYPE_LABEL[base.type]}`
    : CONTACT_TYPE_LABEL[base.type];
  // Save is blocked while a type change is mid-flight with no base picked
  // (KindPicker "Other" before choosing Tenant/Landlord ? kind.type null),
  // and from a save's 409 contact_type_changed until the form is reopened
  // (retypedUnderForm, code review R2 FW2-2).
  const canSave = !saving && kind.type !== null && !retypedUnderForm;

  // Status options for the type the field was last derived for - EXACTLY the
  // header dropdown's list (statusOptionsFor, spec 2026-10-23 D3); no off-list
  // value is ever prepended. statusType, not liveType (plan round 2 R2P-3):
  // during the Other panel's base-less step liveType falls back to the stored
  // type while the field may hold another type's value. statusType equals
  // kind.type whenever kind.type is non-null.
  const statusOptions = statusOptionsFor(statusType);

  return (
    <Modal
      title="Edit contact"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" type="submit" form="contact-edit-form" disabled={!canSave}>
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </>
      }
    >
      <form id="contact-edit-form" className={styles.form} onSubmit={(e) => void onSubmit(e)}>
        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.label}>First name</span>
            <input
              className={styles.input}
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Last name</span>
            <input
              className={styles.input}
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              autoComplete="off"
            />
          </label>
        </div>

        {/* Type - collapsed to a summary + "Change type"; expands to the full
            KindPicker (the same control the create dialog uses). */}
        {changingType ? (
          <div className={styles.fieldset}>
            <span className={styles.label}>Type</span>
            {/* Caseworker is offered only when the STORED contact already is
                one (spec D16, ruling R4-15): an existing contact becomes a
                caseworker through More actions > Make caseworker. */}
            <KindPicker
              value={kind}
              onChange={handleKindChange}
              roleSuggestions={vocab.roles}
              offerCaseworker={isCaseworkerContact(base)}
            />
            {/* A refused type change (409 type_change_refused, spec
                2026-10-12 D2): what blocks it, beside the picker. A type
                change is only possible with this block open. */}
            {typeRefusals !== null ? <TypeChangeRefusalList refusals={typeRefusals} /> : null}
          </div>
        ) : (
          <div className={styles.kindRow}>
            <div className={styles.kindInfo}>
              <span className={styles.label}>Type</span>
              <span className={styles.kindValue}>{currentKindLabel}</span>
            </div>
            <Button variant="secondary" size="sm" type="button" onClick={() => setChangingType(true)}>
              Change type
            </Button>
          </div>
        )}

        {/* Status directly under name + type (Cameron, 2026-07-14): the identity
            trio leads; the type-scoped detail fields follow. The options are
            already re-scoped by the type change handler above. */}
        <label className={styles.field}>
          <span className={styles.label}>Status</span>
          <select className={styles.input} value={status} onChange={(e) => setStatus(e.target.value)}>
            {statusOptions.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>

        {isTenant ? (
          <label className={styles.field}>
            <span className={styles.label}>Voucher size (bedrooms)</span>
            <input
              className={styles.input}
              type="number"
              min={0}
              max={12}
              step={1}
              value={voucher}
              onChange={(e) => setVoucher(e.target.value)}
              placeholder="e.g. 2"
            />
          </label>
        ) : null}

        {isTenant ? (
          <label className={styles.field}>
            <span className={styles.label}>Voucher expiration date</span>
            <input
              className={styles.input}
              type="date"
              value={voucherExpiration}
              onChange={(e) => setVoucherExpiration(e.target.value)}
            />
          </label>
        ) : null}

        {/* The two org fields (spec 2026-10-06 D1, D6): the authority that RUNS
            the voucher and the agency that HELPS the tenant, each a picker
            over its own stored list. A pick or a removed chip is the only
            change; a stored value that is not on the list stays until staff
            change it. */}
        {isTenant ? (
          <>
            <OrgPicker
              ref={housingAuthorityPicker}
              label="Housing authority"
              // A sentence of its own: the field's description joins it with
              // the note under the field (code review R3-FE-8).
              hint="The organization that runs the voucher."
              kinds={HOUSING_AUTHORITY_KINDS}
              entries={orgList.entries}
              loading={orgListUnknown(orgList)}
              disabled={housingAuthorityText.disabled}
              value={housingAuthority}
              onChange={(next) => {
                setHousingAuthority(next);
                setOrgFieldError(null);
              }}
              onPendingTextChange={housingAuthorityText.onPendingTextChange}
              pendingNote={housingAuthorityText.note}
              onRequestAdd={(text) => setAdding({ field: 'housingAuthority', text })}
              error={
                housingAuthorityText.refusal ??
                (orgFieldError?.field === 'housingAuthority' ? orgFieldError.message : null) ??
                (orgList.error ? orgListLoadError(HOUSING_AUTHORITY_KINDS) : null)
              }
              errorAttempt={housingAuthorityText.refusalAttempt}
              className={styles.field}
              labelClassName={styles.label}
            />
            <OrgPicker
              ref={agencyPicker}
              label="Agency"
              kinds={AGENCY_KINDS}
              entries={orgList.entries}
              loading={orgListUnknown(orgList)}
              disabled={agencyText.disabled}
              value={agency}
              onChange={(next) => {
                setAgency(next);
                setOrgFieldError(null);
              }}
              onPendingTextChange={agencyText.onPendingTextChange}
              pendingNote={agencyText.note}
              onRequestAdd={(text) => setAdding({ field: 'agency', text })}
              error={
                agencyText.refusal ??
                (orgFieldError?.field === 'agency' ? orgFieldError.message : null) ??
                (orgList.error ? orgListLoadError(AGENCY_KINDS) : null)
              }
              errorAttempt={agencyText.refusalAttempt}
              className={styles.field}
              labelClassName={styles.label}
            />
          </>
        ) : null}

        {/* A partner's organization (spec 2026-10-06 D17): ONE picker over
            BOTH lists. Its answer is written to `organization` by FIELD,
            whatever the entry's kind (ruling R2-F8); its add step opens the
            form's one "Is this really new?" in organization mode. */}
        {isPartner ? (
          <OrgPicker
            ref={organizationPicker}
            label="Organization"
            kinds={ORGANIZATION_KINDS}
            entries={orgList.entries}
            loading={orgListUnknown(orgList)}
            disabled={organizationText.disabled}
            value={organization}
            onChange={(next) => {
              setOrganization(next);
              setOrgFieldError(null);
            }}
            onPendingTextChange={organizationText.onPendingTextChange}
            pendingNote={organizationText.note}
            onRequestAdd={(text) => setAdding({ field: 'organization', text })}
            error={
              organizationText.refusal ??
              (orgFieldError?.field === 'organization' ? orgFieldError.message : null) ??
              (orgList.error ? orgListLoadError(ORGANIZATION_KINDS) : null)
            }
            errorAttempt={organizationText.refusalAttempt}
            className={styles.field}
            labelClassName={styles.label}
          />
        ) : null}

        {isTenant ? (
          <div className={styles.fieldset}>
            <span className={styles.label}>Eligibility intake</span>
            <label className={styles.field}>
              <span className={styles.label}>Pets</span>
              <input
                className={styles.input}
                value={pets}
                onChange={(e) => setPets(e.target.value)}
                placeholder="e.g. 1 cat"
                autoComplete="off"
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Evictions</span>
              <input
                className={styles.input}
                value={evictions}
                onChange={(e) => setEvictions(e.target.value)}
                placeholder="e.g. none"
                autoComplete="off"
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Time at current address</span>
              <input
                className={styles.input}
                value={tenure}
                onChange={(e) => setTenure(e.target.value)}
                placeholder="e.g. 3 years"
                autoComplete="off"
              />
            </label>
            <label className={styles.checkboxField}>
              <input
                type="checkbox"
                checked={lifEligible}
                onChange={(e) => setLifEligible(e.target.checked)}
              />
              <span className={styles.label}>LIF eligible</span>
            </label>
            {/* WP1 B1 (spec D2): the tenant matching inputs, in list order,
                each by its `control`. The label sits outside the control
                (htmlFor) so the portion's "$" stays out of its name. The
                portion takes step="any" and no min / max ON PURPOSE: native
                validation would refuse a bad value in the browser's words
                first, and spec D2 wants the server's (C3). The text controls
                take no maxLength for the same reason (FW-12, R1 CONF-6): a
                cap would cut a long paste silently - and count the
                surrounding spaces the trim drops - so an over-long value
                reaches Save and the server's own copy instead. */}
            {TENANT_MATCHING_INPUTS.map((input) => {
              const id = `${matchingId}-${input.key}`;
              const value = matching[input.key] ?? '';
              const onChange = (next: string): void =>
                setMatching((prev) => ({ ...prev, [input.key]: next }));
              return (
                <div key={input.key} className={styles.field}>
                  <label className={styles.label} htmlFor={id}>
                    {input.label}
                  </label>
                  {input.control === 'textarea' ? (
                    <textarea
                      id={id}
                      className={styles.textarea}
                      value={value}
                      onChange={(e) => onChange(e.target.value)}
                      rows={3}
                    />
                  ) : input.control === 'dollars' ? (
                    <span className={styles.dollarsRow}>
                      <span aria-hidden="true">$</span>
                      <input
                        id={id}
                        ref={(el) => {
                          if (el === null) dollarsInputs.current.delete(input.key);
                          else dollarsInputs.current.set(input.key, el);
                        }}
                        className={styles.input}
                        type="number"
                        inputMode="numeric"
                        step="any"
                        value={value}
                        onChange={(e) => onChange(e.target.value)}
                        placeholder="e.g. 400"
                      />
                    </span>
                  ) : (
                    <input
                      id={id}
                      className={styles.input}
                      value={value}
                      onChange={(e) => onChange(e.target.value)}
                      autoComplete="off"
                    />
                  )}
                </div>
              );
            })}
          </div>
        ) : null}

        {isTenant ? (
          <div className={styles.fieldset}>
            <span className={styles.label}>Current address</span>
            <label className={styles.field}>
              <span className={styles.srLabel}>Street address</span>
              <input
                className={styles.input}
                value={line1}
                onChange={(e) => setLine1(e.target.value)}
                placeholder="Street address"
                autoComplete="off"
              />
            </label>
            <label className={styles.field}>
              <span className={styles.srLabel}>Apt / unit</span>
              <input
                className={styles.input}
                value={line2}
                onChange={(e) => setLine2(e.target.value)}
                placeholder="Apt, suite, unit (optional)"
                autoComplete="off"
              />
            </label>
            <div className={styles.row}>
              <label className={styles.field}>
                <span className={styles.srLabel}>City</span>
                <input
                  className={styles.input}
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="City"
                  autoComplete="off"
                />
              </label>
              <label className={`${styles.field} ${styles.stateField}`}>
                <span className={styles.srLabel}>State</span>
                <input
                  className={styles.input}
                  value={stateField}
                  onChange={(e) => setStateField(e.target.value)}
                  placeholder="State"
                  autoComplete="off"
                />
              </label>
              <label className={`${styles.field} ${styles.zipField}`}>
                <span className={styles.srLabel}>ZIP</span>
                <input
                  className={styles.input}
                  value={zip}
                  onChange={(e) => setZip(e.target.value)}
                  placeholder="ZIP"
                  autoComplete="off"
                />
              </label>
            </div>
          </div>
        ) : null}

        {isLandlord ? (
          <label className={styles.field}>
            <span className={styles.label}>Company</span>
            <input
              className={styles.input}
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              autoComplete="off"
            />
          </label>
        ) : null}

        {isLandlord ? (
          <div className={styles.fieldset}>
            <span className={styles.label}>Landlord onboarding</span>
            <label className={styles.field}>
              <span className={styles.label}>Contract status</span>
              <select
                className={styles.input}
                value={contractStatus}
                onChange={(e) => setContractStatus(e.target.value)}
              >
                <option value="">—</option>
                <option value="unsigned">Unsigned</option>
                <option value="signed">Signed</option>
              </select>
            </label>
            <label className={styles.checkboxField}>
              <input
                type="checkbox"
                checked={registeredLandlord}
                onChange={(e) => setRegisteredLandlord(e.target.checked)}
                aria-describedby="obh-registered"
              />
              <span className={styles.label}>Registered landlord</span>
              <span
                className={styles.info}
                title={LANDLORD_ONBOARDING_HINTS.registered_landlord}
                aria-hidden="true"
              >
                ⓘ
              </span>
            </label>
            <span id="obh-registered" className={styles.srLabel}>
              {LANDLORD_ONBOARDING_HINTS.registered_landlord}
            </span>
            <label className={styles.checkboxField}>
              <input
                type="checkbox"
                checked={rtaWithin48h}
                onChange={(e) => setRtaWithin48h(e.target.checked)}
                aria-describedby="obh-rta48"
              />
              <span className={styles.label}>Submits RTA within 48h</span>
              <span
                className={styles.info}
                title={LANDLORD_ONBOARDING_HINTS.rta_within_48h}
                aria-hidden="true"
              >
                ⓘ
              </span>
            </label>
            <span id="obh-rta48" className={styles.srLabel}>
              {LANDLORD_ONBOARDING_HINTS.rta_within_48h}
            </span>
            <label className={styles.checkboxField}>
              <input
                type="checkbox"
                checked={passInspection}
                onChange={(e) => setPassInspection(e.target.checked)}
                aria-describedby="obh-inspection"
              />
              <span className={styles.label}>Passes inspection first try</span>
              <span
                className={styles.info}
                title={LANDLORD_ONBOARDING_HINTS.pass_inspection_first_try}
                aria-hidden="true"
              >
                ⓘ
              </span>
            </label>
            <span id="obh-inspection" className={styles.srLabel}>
              {LANDLORD_ONBOARDING_HINTS.pass_inspection_first_try}
            </span>
            <label className={styles.checkboxField}>
              <input
                type="checkbox"
                checked={incomeIncludesVoucher}
                onChange={(e) => setIncomeIncludesVoucher(e.target.checked)}
                aria-describedby="obh-voucher"
              />
              <span className={styles.label}>Voucher counts as income</span>
              <span
                className={styles.info}
                title={LANDLORD_ONBOARDING_HINTS.income_includes_voucher}
                aria-hidden="true"
              >
                ⓘ
              </span>
            </label>
            <span id="obh-voucher" className={styles.srLabel}>
              {LANDLORD_ONBOARDING_HINTS.income_includes_voucher}
            </span>
            <label className={styles.field}>
              <span className={styles.label}>Park reason</span>
              <textarea
                className={styles.textarea}
                value={parkReason}
                onChange={(e) => setParkReason(e.target.value)}
                rows={2}
                placeholder="Why the lead was parked (declined / not a fit / never signed)"
              />
            </label>
          </div>
        ) : null}

        {/* D9: the landlord's requirements - copy-only defaults its properties
            get at create and through Apply to properties. Tags read On
            property flyers / Staff only (they reach flyers only through
            properties). */}
        {isLandlord ? (
          <fieldset className={styles.requirementsFieldset}>
            <legend className={styles.label}>Requirements / Qualifications</legend>
            <FlyerLegend audience="landlord" />
            <RequirementsFields
              values={requirements}
              onChange={setRequirements}
              audience="landlord"
              disabled={saving}
            />
          </fieldset>
        ) : null}

        {isTenant ? (
          <label className={styles.checkboxField}>
            <input
              type="checkbox"
              checked={porting}
              onChange={(e) => setPorting(e.target.checked)}
            />
            <span className={styles.label}>Porting in from another jurisdiction</span>
          </label>
        ) : null}

        {notesConflict !== null ? (
          // WP1 B2a D14.3: the Staff notes card's conflict panel, beside the
          // Notes box (outside its wrapping label, so it never joins the
          // box's accessible name) and linked to it by aria-describedby.
          <div id={notesConflictId} role="alert" className={styles.conflict}>
            <p className={styles.conflictLead}>{NOTES_STALE_COPY}</p>
            {notesConflict.trim().length > 0 ? (
              <p className={styles.conflictText}>{notesConflict}</p>
            ) : (
              <p className={styles.conflictEmpty}>(The notes were cleared.)</p>
            )}
          </div>
        ) : null}
        <label className={styles.field}>
          <span className={styles.label}>Notes</span>
          <textarea
            ref={notesRef}
            className={styles.textarea}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            {...(notesConflict !== null && { 'aria-describedby': notesConflictId })}
          />
        </label>

        {/* Relationships */}
        {showRelationships ? (
          <div className={styles.fieldset}>
            <span className={styles.label}>Relationships</span>
            <RelationshipsEditor
              rows={relRows}
              onChange={setRelRows}
              candidates={candidates}
              roleSuggestions={vocab.relationshipRoles}
            />
          </div>
        ) : (
          <Button variant="secondary" size="sm" type="button" onClick={handleShowRelationships}>
            + Add relationship
          </Button>
        )}

        {/* Custom fields */}
        {showCustomFields ? (
          <div className={styles.fieldset}>
            <span className={styles.label}>Custom fields</span>
            <CustomFieldsEditor
              rows={cfRows}
              onChange={setCfRows}
              labelSuggestions={vocab.fieldLabels}
            />
          </div>
        ) : (
          <Button variant="secondary" size="sm" type="button" onClick={handleShowCustomFields}>
            + Add custom field
          </Button>
        )}

        {error !== null ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
      </form>
      {adding !== null ? (
        <NewOrgDialog
          kind={newOrgDialogKind(adding.field)}
          text={adding.text}
          mode="field"
          onUse={(ref) => {
            // The server's own answer: counted as on the list at once, even
            // when this form's list was read before the name joined it
            // (code review R1-ADV-FE-7).
            orgList.noteAdded(ref);
            applyOrg(adding.field, ref);
            setAdding(null);
          }}
          onUseOtherField={(ref) => {
            orgList.noteAdded(ref);
            applyOrg(adding.field, ref);
            setAdding(null);
          }}
          onAdded={(entry) => {
            // Counted as on the list at once: no "Not on the list" flash on its chip.
            orgList.noteAdded(entry);
            applyOrg(adding.field, entry);
            setAdding(null);
          }}
          onClose={() => setAdding(null)}
        />
      ) : null}
    </Modal>
  );
}
