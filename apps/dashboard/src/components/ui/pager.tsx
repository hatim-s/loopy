import type { ReactNode } from "react";
import type { Page, Pager, ScanInfo } from "../../lib/view-models.ts";
import { Icon } from "./icon.tsx";

/**
 * The table footer: what the rows are on the left, the keyset pager on the right. Pages move
 * one at a time and show the rows' range, never a page number, because keyset pages have none.
 */
export function PagerFoot<Row, Extra>(props: {
  pager: Pager<Row, Extra>;
  page: Page<Row>;
  noun: string;
  children?: ReactNode;
}) {
  const { pager, page, noun, children } = props;
  const first = page.offset + 1;
  const last = page.offset + page.rows.length;

  return (
    <div className="table-foot">
      <span className="min-w-0 flex-1">{children}</span>
      <span className="tabular-nums" aria-live="polite">
        {page.rows.length === 0
          ? `No ${noun}`
          : `${first.toLocaleString()} to ${last.toLocaleString()}`}
      </span>
      <span className="flex items-center gap-0.5">
        <button
          type="button"
          className="icon-btn"
          onClick={pager.previous}
          disabled={!page.hasPrevious}
          aria-label={`Newer ${noun}`}
        >
          <Icon name="left" />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={pager.next}
          disabled={!page.hasNext}
          aria-label={`Older ${noun}`}
        >
          <Icon name="right" />
        </button>
      </span>
    </div>
  );
}

/** Where a bounded scan stopped and how far back the daemon keeps rows. */
export function ScanNote({ scan, noun }: { scan: ScanInfo; noun: string }) {
  const parts: string[] = [];

  if (scan.searchedBackTo !== null) {
    parts.push(`Searched back to ${new Date(scan.searchedBackTo).toLocaleString()}.`);
  }

  if (scan.retained !== null) {
    parts.push(`The daemon keeps ${noun} from ${new Date(scan.retained.oldest).toLocaleString()}.`);
  }

  if (scan.newer !== null && scan.newer > 0) {
    parts.push(`${scan.newer.toLocaleString()} newer ${noun} since this page loaded.`);
  }

  return <>{parts.join(" ")}</>;
}
