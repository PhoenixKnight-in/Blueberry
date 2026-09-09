/**
 * Page controls for the table.
 *
 * The backend returns `total` alongside the page, which is what lets this say
 * "26–50 of 231" from one request instead of guessing whether another page
 * exists by asking for it.
 */

interface PaginationProps {
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly loading: boolean;
  readonly onOffsetChange: (offset: number) => void;
}

export function Pagination({
  total,
  offset,
  limit,
  loading,
  onOffsetChange,
}: PaginationProps) {
  if (total === 0) {
    return null;
  }

  const first = offset + 1;
  const last = Math.min(offset + limit, total);
  const hasPrevious = offset > 0;
  const hasNext = last < total;

  return (
    <div className="pagination">
      <span>
        Showing <strong>{first}</strong>–<strong>{last}</strong> of{' '}
        <strong>{total.toLocaleString('en-US')}</strong>
      </span>
      <span className="button-group">
        <button
          type="button"
          disabled={!hasPrevious || loading}
          onClick={() => onOffsetChange(Math.max(0, offset - limit))}
        >
          Previous
        </button>
        <button
          type="button"
          disabled={!hasNext || loading}
          onClick={() => onOffsetChange(offset + limit)}
        >
          Next
        </button>
      </span>
    </div>
  );
}
