import type { ReactNode } from "react";
import type { Pager, ScanInfo } from "../../lib/view-models";
import { Icon } from "./icon";

/**
 * The table footer: what the rows are on the left, the keyset pager on the right. Pages move
 * one at a time and show the rows' range, never a page number, because keyset pages have none.
 */
export function PagerFoot<Row, Extra>(props: {
  pager: Pager<Row, Extra>;
  noun: string;
  children?: ReactNode;
}) {
  const { pager, noun, children } = props;

  if (pager.state !== "ready") {
    return null;
  }

  const page = pager.data;
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

export function ScanNote({ scan, noun }: { scan: ScanInfo; noun: string }) {
  const parts: string[] = [];

  if (scan.searchedBackTo !== null) {
    parts.push(`Searched back to ${new Date(scan.searchedBackTo).toLocaleString()}.`);
  }

  if (scan.retained !== null) {
    parts.push(`The daemon keeps ${noun} from ${new Date(scan.retained.oldest).toLocaleString()}.`);
  }

  return <>{parts.join(" ")}</>;
}
