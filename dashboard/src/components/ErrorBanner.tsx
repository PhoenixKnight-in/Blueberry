/**
 * The "we could not answer" banner.
 *
 * The single most important component on the page for honesty. When the
 * backend is unreachable the table has no rows — and an empty table with no
 * explanation says "nothing has ever been flagged", which is the opposite of
 * the truth. This banner is what keeps those two states distinguishable.
 */

interface ErrorBannerProps {
  readonly title: string;
  readonly detail: string;
  readonly onRetry?: () => void;
}

export function ErrorBanner({ title, detail, onRetry }: ErrorBannerProps) {
  return (
    <div className="banner banner--error" role="alert">
      <span className="banner__glyph" aria-hidden="true">
        ▲
      </span>
      <div className="banner__body">
        <div className="banner__title">{title}</div>
        <div className="banner__detail">{detail}</div>
      </div>
      {onRetry ? (
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}
