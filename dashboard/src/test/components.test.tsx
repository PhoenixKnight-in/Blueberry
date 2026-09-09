/**
 * Component tests.
 *
 * The recurring assertion: **severity is never communicated by colour alone.**
 * jsdom has no notion of colour, which turns out to be exactly the right test
 * environment for that rule — if a severity can be read here, it can be read
 * by someone who cannot distinguish the hues.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ErrorBanner } from '../components/ErrorBanner';
import { FilterBar } from '../components/FilterBar';
import { FlaggedPackageTable } from '../components/FlaggedPackageTable';
import { PackageDetail } from '../components/PackageDetail';
import { Pagination } from '../components/Pagination';
import { SeverityBadge } from '../components/SeverityBadge';
import { SeverityBar } from '../components/SeverityBar';
import { SignalList } from '../components/SignalList';
import { StatsBar } from '../components/StatsBar';
import type { Filters } from '../types';
import { HALLUCINATED, ROWS, STATS, TYPOSQUAT, detail } from './fixtures';

const NO_FILTERS: Filters = { search: '', severity: '', status: '', minScore: null };

const noop = () => {};

describe('SeverityBadge', () => {
  it('renders the severity as readable text, not only as a colour', () => {
    render(<SeverityBadge severity="high_risk" />);

    expect(screen.getByText('High risk')).toBeInTheDocument();
  });

  it('carries a glyph alongside the label', () => {
    const { container } = render(<SeverityBadge severity="caution" />);

    expect(container.querySelector('.severity-badge__glyph')).not.toBeNull();
  });
});

describe('SeverityBar', () => {
  it('labels every class with its count, so the bar is never the only source', () => {
    render(<SeverityBar counts={{ safe: 180, caution: 31, high_risk: 20 }} />);

    const legend = screen.getByRole('list');
    expect(within(legend).getByText('180')).toBeInTheDocument();
    expect(within(legend).getByText('31')).toBeInTheDocument();
    expect(within(legend).getByText('20')).toBeInTheDocument();
  });

  it('names all three classes even when one is empty', () => {
    render(<SeverityBar counts={{ safe: 5, caution: 0, high_risk: 0 }} />);

    expect(screen.getByText('Safe')).toBeInTheDocument();
    expect(screen.getByText('Caution')).toBeInTheDocument();
    expect(screen.getByText('High risk')).toBeInTheDocument();
  });

  it('renders an empty track rather than dividing by zero', () => {
    const { container } = render(
      <SeverityBar counts={{ safe: 0, caution: 0, high_risk: 0 }} />,
    );

    expect(container.querySelector('.severity-bar__empty')).not.toBeNull();
  });

  it('sizes each segment by its share', () => {
    const { container } = render(
      <SeverityBar counts={{ safe: 50, caution: 25, high_risk: 25 }} />,
    );
    const segments = container.querySelectorAll('.severity-bar__segment');

    expect(segments).toHaveLength(3);
    expect((segments[0] as HTMLElement).style.width).toBe('50%');
  });
});

describe('StatsBar', () => {
  it('shows the headline numbers', () => {
    render(<StatsBar stats={STATS} loading={false} />);

    expect(screen.getByText('231')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument(); // open flags
    expect(screen.getByText('7')).toBeInTheDocument(); // hallucinated
  });

  it('shows a loading state before the first response', () => {
    render(<StatsBar stats={null} loading />);

    expect(screen.getByText(/Loading summary/)).toBeInTheDocument();
  });
});

describe('FlaggedPackageTable', () => {
  it('renders one row per check', () => {
    render(
      <FlaggedPackageTable
        rows={ROWS}
        loading={false}
        selectedId={null}
        busyId={null}
        onSelect={noop}
        onStatusChange={noop}
        filtersActive={false}
      />,
    );

    expect(screen.getAllByRole('row')).toHaveLength(ROWS.length + 1); // + header
  });

  it('shows the reason beside every score', () => {
    render(
      <FlaggedPackageTable
        rows={[TYPOSQUAT]}
        loading={false}
        selectedId={null}
        busyId={null}
        onSelect={noop}
        onStatusChange={noop}
        filtersActive={false}
      />,
    );

    expect(screen.getByText(/single character away from 'urllib3'/)).toBeInTheDocument();
    expect(screen.getByText('75')).toBeInTheDocument();
  });

  it('distinguishes "no results for these filters" from "nothing checked yet"', () => {
    const { rerender } = render(
      <FlaggedPackageTable
        rows={[]}
        loading={false}
        selectedId={null}
        busyId={null}
        onSelect={noop}
        onStatusChange={noop}
        filtersActive
      />,
    );
    expect(screen.getByText(/Nothing matches these filters/)).toBeInTheDocument();

    rerender(
      <FlaggedPackageTable
        rows={[]}
        loading={false}
        selectedId={null}
        busyId={null}
        onSelect={noop}
        onStatusChange={noop}
        filtersActive={false}
      />,
    );
    expect(screen.getByText(/No checks recorded yet/)).toBeInTheDocument();
  });

  it('opens the detail view when a package name is clicked', async () => {
    const onSelect = vi.fn();
    render(
      <FlaggedPackageTable
        rows={[HALLUCINATED]}
        loading={false}
        selectedId={null}
        busyId={null}
        onSelect={onSelect}
        onStatusChange={noop}
        filtersActive={false}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /Show why reqeusts/ }));

    expect(onSelect).toHaveBeenCalledWith(HALLUCINATED.id);
  });

  it('triages a row', async () => {
    const onStatusChange = vi.fn();
    render(
      <FlaggedPackageTable
        rows={[TYPOSQUAT]}
        loading={false}
        selectedId={null}
        busyId={null}
        onSelect={noop}
        onStatusChange={onStatusChange}
        filtersActive={false}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Resolve' }));

    expect(onStatusChange).toHaveBeenCalledWith(TYPOSQUAT.id, 'resolved');
  });

  it('disables the action a row is already in', () => {
    render(
      <FlaggedPackageTable
        rows={[TYPOSQUAT]}
        loading={false}
        selectedId={null}
        busyId={null}
        onSelect={noop}
        onStatusChange={noop}
        filtersActive={false}
      />,
    );

    // TYPOSQUAT is 'open', so reopening it is a no-op.
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Ignore' })).toBeEnabled();
  });
});

describe('FilterBar', () => {
  it('reports a search term', async () => {
    const onChange = vi.fn();
    render(<FilterBar filters={NO_FILTERS} onChange={onChange} />);

    await userEvent.type(screen.getByLabelText('Package name'), 'u');

    expect(onChange).toHaveBeenCalledWith({ ...NO_FILTERS, search: 'u' });
  });

  it('reports a severity choice', async () => {
    const onChange = vi.fn();
    render(<FilterBar filters={NO_FILTERS} onChange={onChange} />);

    await userEvent.selectOptions(screen.getByLabelText('Severity'), 'high_risk');

    expect(onChange).toHaveBeenCalledWith({ ...NO_FILTERS, severity: 'high_risk' });
  });

  it('reports a cleared minimum score as null, not as zero', async () => {
    // Zero is a real filter ("score at least 0"); an empty box is no filter.
    const onChange = vi.fn();
    render(
      <FilterBar filters={{ ...NO_FILTERS, minScore: 60 }} onChange={onChange} />,
    );

    await userEvent.clear(screen.getByLabelText('Minimum score'));

    expect(onChange).toHaveBeenCalledWith({ ...NO_FILTERS, minScore: null });
  });

  it('clears every filter at once', async () => {
    const onChange = vi.fn();
    render(
      <FilterBar
        filters={{ search: 'x', severity: 'safe', status: 'open', minScore: 10 }}
        onChange={onChange}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(onChange).toHaveBeenCalledWith(NO_FILTERS);
  });
});

describe('Pagination', () => {
  it('states the range and the total', () => {
    render(
      <Pagination total={231} offset={25} limit={25} loading={false} onOffsetChange={noop} />,
    );

    expect(screen.getByText('26')).toBeInTheDocument();
    expect(screen.getByText('50')).toBeInTheDocument();
    expect(screen.getByText('231')).toBeInTheDocument();
  });

  it('disables Previous on the first page', () => {
    render(
      <Pagination total={231} offset={0} limit={25} loading={false} onOffsetChange={noop} />,
    );

    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('disables Next on the last page', () => {
    render(
      <Pagination total={30} offset={25} limit={25} loading={false} onOffsetChange={noop} />,
    );

    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('advances by one page', async () => {
    const onOffsetChange = vi.fn();
    render(
      <Pagination
        total={231}
        offset={0}
        limit={25}
        loading={false}
        onOffsetChange={onOffsetChange}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(onOffsetChange).toHaveBeenCalledWith(25);
  });

  it('renders nothing when there is nothing to page through', () => {
    const { container } = render(
      <Pagination total={0} offset={0} limit={25} loading={false} onOffsetChange={noop} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});

describe('SignalList', () => {
  it('lists every rule with its signed points', () => {
    render(<SignalList signals={detail().signals} finalScore={75} />);

    expect(screen.getByText('+60')).toBeInTheDocument();
    expect(screen.getByText('+15')).toBeInTheDocument();
  });

  it('shows the final score, which the listed points add up to', () => {
    // 60 + 15 = 75, on screen and reconstructable by hand.
    render(<SignalList signals={detail().signals} finalScore={75} />);

    expect(screen.getByText('Final score')).toBeInTheDocument();
    expect(screen.getByText('75')).toBeInTheDocument();
  });

  it('says so when the engine clamped the total', () => {
    const signals = [
      { rule_id: 'package_not_on_pypi', points: 100, message: 'Not on PyPI.' },
      { rule_id: 'typosquat_distance_1', points: 60, message: 'One edit away.' },
    ];

    render(<SignalList signals={signals} finalScore={100} />);

    expect(screen.getByText(/clamped to 0–100/)).toBeInTheDocument();
  });

  it('handles a package with no fired rules', () => {
    render(<SignalList signals={[]} finalScore={0} />);

    expect(screen.getByText(/No rules fired/)).toBeInTheDocument();
  });
});

describe('PackageDetail', () => {
  it('shows the score, the checks, and the reasons', () => {
    render(<PackageDetail detail={detail()} loading={false} onClose={noop} />);

    expect(screen.getByRole('heading', { name: 'urllib4' })).toBeInTheDocument();
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '75');
    expect(screen.getByText('no repository linked')).toBeInTheDocument();
    expect(screen.getByText(/urllib3 \(1 edit, 86% similar\)/)).toBeInTheDocument();
  });

  it('states plainly when a package does not exist', () => {
    render(
      <PackageDetail
        detail={detail({ ...HALLUCINATED, explanation: [], signals: [], pypi_metadata: null, github_detail: null, similarity_detail: null, error: null })}
        loading={false}
        onClose={noop}
      />,
    );

    expect(screen.getByText(/NO — this package does not exist/)).toBeInTheDocument();
  });

  it('says an unreachable GitHub was not scored', () => {
    // Zero points from an unreachable check must not read as a clean result.
    render(
      <PackageDetail
        detail={detail({ github_status: 'unavailable' })}
        loading={false}
        onClose={noop}
      />,
    );

    expect(screen.getByText(/could not be reached \(not scored\)/)).toBeInTheDocument();
  });

  it('closes', async () => {
    const onClose = vi.fn();
    render(<PackageDetail detail={detail()} loading={false} onClose={onClose} />);

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalled();
  });

  it('renders nothing when no row is selected', () => {
    const { container } = render(
      <PackageDetail detail={null} loading={false} onClose={noop} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});

describe('ErrorBanner', () => {
  it('is announced as an alert', () => {
    render(<ErrorBanner title="Could not load" detail="backend is down" />);

    expect(screen.getByRole('alert')).toHaveTextContent('backend is down');
  });

  it('offers a retry when one is possible', async () => {
    const onRetry = vi.fn();
    render(<ErrorBanner title="Could not load" detail="down" onRetry={onRetry} />);

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(onRetry).toHaveBeenCalled();
  });
});
