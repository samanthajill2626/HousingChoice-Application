import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ImageViewerProvider } from '../../ui/imageViewer/ImageViewerProvider.js';
import {
  installImageViewerResizeObserver,
  loadViewerImage,
} from '../../ui/imageViewer/ImageViewer.testUtils.js';
import { UnknownFile, type TriageError } from './UnknownFile.js';
import { TYPE_CHANGE_LANDLORD_SENTENCE } from '../../lib/holdingRefusals.js';
import type { SuggestedContactKind } from './contactProfile.js';
import type { CommsMediaItem } from './media.js';
import type { Contact, GroupThreadRow, SuggestionItem } from '../../api/index.js';

const UNKNOWN: Contact = {
  contactId: 'u9',
  type: 'unknown',
  status: 'needs_review',
  phone: '+15550100001',
};

function typeSuggestion(suggestedValue: string): SuggestionItem {
  return {
    itemId: 'sugg#u9#type', ownerContactId: 'u9', target: 'type', suggestedValue,
    reason: 'stated role', conversationId: 'conv-1', createdAt: '2026-08-26T10:00:00.000Z',
  };
}

function renderIt(opts: {
  suggestions?: SuggestionItem[];
  groupThreads?: GroupThreadRow[];
  onTriage?: (kind: SuggestedContactKind) => void;
  onMakeCaseworker?: () => void;
  triaging?: boolean;
  media?: CommsMediaItem[];
  triageError?: TriageError | null;
} = {}): void {
  render(
    <MemoryRouter>
      <ImageViewerProvider>
        <UnknownFile
          contact={UNKNOWN}
          phones={[{ phone: '+15550100001', primary: true }]}
          placements={[]}
          units={[]}
          media={opts.media ?? []}
          suggestions={opts.suggestions ?? []}
          onTriage={opts.onTriage ?? vi.fn()}
          onMakeCaseworker={opts.onMakeCaseworker ?? vi.fn()}
          triaging={opts.triaging}
          triageError={opts.triageError ?? null}
          groupThreadsPending={false}
          groupThreads={opts.groupThreads ?? []}
          groupThreadsTruncated={false}
        />
      </ImageViewerProvider>
    </MemoryRouter>,
  );
}

describe('UnknownFile AI type recommendation', () => {
  it('shows an "AI suggests: Tenant - <reason>" line when a type suggestion exists', () => {
    renderIt({ suggestions: [
      {
        itemId: 'sugg#u9#type',
        ownerContactId: 'u9',
        target: 'type',
        suggestedValue: 'tenant',
        reason: 'looking for a home',
        conversationId: 'conv-1',
        createdAt: '2026-07-16T10:00:00.000Z',
      },
    ] });
    expect(screen.getByText(/AI suggests:\s*Tenant/i)).toBeInTheDocument();
    expect(screen.getByText(/looking for a home/i)).toBeInTheDocument();
    // The Mark-as buttons remain the action.
    expect(screen.getByRole('button', { name: /Mark as Tenant/i })).toBeEnabled();
  });

  it('shows no AI line when there is no type suggestion', () => {
    renderIt();
    expect(screen.queryByText(/AI suggests:/i)).not.toBeInTheDocument();
  });
});

describe('UnknownFile classification actions', () => {
  it.each([
    ['partner', 'Partner'],
    ['property_manager', 'Property Manager'],
  ] as const)('shows the exact %s suggestion label', (value, label) => {
    renderIt({ suggestions: [typeSuggestion(value)] });
    expect(screen.getByText(`AI suggests: ${label} - stated role`)).toBeInTheDocument();
  });

  it('renders five actions in KindPicker order and reports canonical kinds', async () => {
    const onTriage = vi.fn();
    const user = userEvent.setup();
    renderIt({ onTriage });
    const buttons = screen.getAllByRole('button').filter((button) => button.textContent?.startsWith('Mark as '));
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Mark as Tenant', 'Mark as Landlord', 'Mark as Partner', 'Mark as Caseworker', 'Mark as Property Manager',
    ]);
    await user.click(screen.getByRole('button', { name: 'Mark as Partner' }));
    await user.click(screen.getByRole('button', { name: 'Mark as Property Manager' }));
    expect(onTriage).toHaveBeenNthCalledWith(1, 'partner');
    expect(onTriage).toHaveBeenNthCalledWith(2, 'property_manager');
  });

  it('disables all five actions during one in-flight classification', () => {
    renderIt({ triaging: true });
    for (const name of [
      'Mark as Tenant',
      'Mark as Landlord',
      'Mark as Partner',
      'Mark as Caseworker',
      'Mark as Property Manager',
    ]) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
  });
});

describe('UnknownFile media gallery', () => {
  it('opens an eligible media image in the shared viewer', async () => {
    const restoreResizeObserver = installImageViewerResizeObserver({ width: 1000, height: 600 });
    const user = userEvent.setup();
    try {
      renderIt({
        media: [{
          key: 'MMUNKNOWN:0',
          src: '/api/messages/MMUNKNOWN/media/0',
          contentType: 'image/png',
          at: '2026-08-27T12:00:00Z',
        }],
      });

      expect(screen.getByRole('heading', { name: 'Media from comms' })).toBeInTheDocument();
      const trigger = screen.getByRole('button', { name: 'View image attachment' });
      expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
      await user.click(trigger);
      const dialog = screen.getByRole('dialog', { name: 'Image attachment' });
      const viewerImage = await loadViewerImage(dialog, 'Image attachment');
      expect(viewerImage).toHaveAttribute('src', '/api/messages/MMUNKNOWN/media/0');
    } finally {
      restoreResizeObserver();
    }
  });
});

// C13 / conformance F13. `unknown` + `needs_review` is EXACTLY the state every
// detection-minted group member stub is in (app/src/services/groupMembers.ts),
// and useContactFile already pays for the /group-threads read on every contact -
// so this was the one page most likely to need the card and the one page that
// did not have it.
describe('UnknownFile group threads', () => {
  it('shows the Group threads card - a detected group member starts life untriaged', () => {
    renderIt({ groupThreads: [
      {
        conversationId: 'gt-1',
        memberCount: 3,
        lastActivityAt: '2026-06-17T10:00:00.000Z',
        title: 'With Ann & Marcus',
        otherMemberNames: ['Ann Tenant', 'Marcus Landlord'],
      },
    ] });
    expect(screen.getByRole('heading', { name: 'Group threads' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /With Ann & Marcus/ })).toHaveAttribute(
      'href',
      '/conversations/gt-1',
    );
  });

  it('shows the card empty rather than hiding it when they are in no group texts', () => {
    renderIt();
    expect(screen.getByRole('heading', { name: 'Group threads' })).toBeInTheDocument();
    expect(screen.getByText('No group texts yet.')).toBeInTheDocument();
  });
});

describe('UnknownFile - Mark as Caseworker (spec 2026-10-06 D16)', () => {
  it('opens the conversion, never the triage PATCH', async () => {
    const onTriage = vi.fn();
    const onMakeCaseworker = vi.fn();
    const user = userEvent.setup();
    renderIt({ onTriage, onMakeCaseworker });
    await user.click(screen.getByRole('button', { name: 'Mark as Caseworker' }));
    expect(onMakeCaseworker).toHaveBeenCalledTimes(1);
    expect(onTriage).not.toHaveBeenCalled();
  });

  it('the card says Caseworker is one of the kinds', () => {
    renderIt();
    expect(screen.getByText(/Tenant, Landlord, Partner, Caseworker, or Property Manager/)).toBeInTheDocument();
  });
});

describe('UnknownFile - a Mark as failure on the card (spec 2026-10-12 D2)', () => {
  const card = (): HTMLElement =>
    screen.getByRole('heading', { name: 'Needs triage' }).closest('section') as HTMLElement;

  it('a refused type change shows each refusal sentence with its View link', () => {
    renderIt({
      triageError: {
        refusals: [
          { code: 'open_placement', placementId: 'p 7' },
          { code: 'open_tour', tourId: 't1' },
          { code: 'landlord_of_record', unitId: 'u1' },
        ],
      },
    });
    const alert = within(card()).getByRole('alert');
    expect(within(alert).getByText("Finish or close this contact's placement first.")).toBeInTheDocument();
    expect(within(alert).getByText("Cancel or close this contact's open tour first.")).toBeInTheDocument();
    expect(within(alert).getByText(TYPE_CHANGE_LANDLORD_SENTENCE)).toBeInTheDocument();
    expect(within(alert).getByRole('link', { name: 'View placement' })).toHaveAttribute('href', '/placements/p%207');
    expect(within(alert).getByRole('link', { name: 'View tour' })).toHaveAttribute('href', '/tours/t1');
    expect(within(alert).getByRole('link', { name: 'View property' })).toHaveAttribute('href', '/listings/u1');
    // The actions stay available for a retry.
    expect(screen.getByRole('button', { name: 'Mark as Tenant' })).toBeEnabled();
  });

  it('any other failure shows its sentence on the card', () => {
    renderIt({ triageError: { message: "Couldn't save - please try again." } });
    expect(within(card()).getByRole('alert')).toHaveTextContent("Couldn't save - please try again.");
  });

  it('(PIN) shows nothing on the card without a failure', () => {
    renderIt();
    expect(within(card()).queryByRole('alert')).toBeNull();
  });
});
