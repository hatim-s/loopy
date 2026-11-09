import { describeCron } from "@loopy/contract";
import { Link } from "@tanstack/react-router";
import { elapsed, runElapsed, shortId, span } from "../../lib/format";
import { useRunPages } from "../../lib/pages";
import { useLoopyRows, useScheduleOverview } from "../../lib/ui-data";
import { isWaiting, pageCount, useAwaitingRuns, type WaitingRun } from "../../lib/waiting";
import { RespondRow } from "../respond";
import { FireTime } from "../schedules/text";
import { Load, Note } from "../ui/load";
import { RunPill, StatusPill } from "../ui/status";

const LIST_PAGE = 20;

function PanelHead(props: {
  title: string;
  count?: string;
  to: "/runs" | "/schedules";
  search?: object;
  link: string;
}) {
  const { title, count, to, link } = props;

  return (
    <div className="panel-head">
      <h2>{title}</h2>
      {count !== undefined && <span className="text-muted tabular-nums">{count}</span>}
      <Link to={to} search={props.search} className="ml-auto text-xs">
        {link}
      </Link>
    </div>
  );
}

function AwaitingRow({ run, now }: { run: WaitingRun; now: number }) {
  return (
    <li className="border-b border-line px-4 py-3 last:border-b-0">
      <RespondRow run={run} rowClassName="gap-x-2.5" formClassName="">
        <StatusPill status="awaiting" small />
        <Link
          to="/runs/$runId"
          params={{ runId: run.id }}
          className="font-medium text-ink hover:text-active"
        >
          {run.loopy.slug}
        </Link>
        <span className="text-xs text-muted">
          on <code>{run.waitingOn.hook}</code> for {span(now - Date.parse(run.waitingOn.since))}
        </span>
      </RespondRow>
    </li>
  );
}

export function AwaitingYou({ now }: { now: number }) {
  const pager = useAwaitingRuns();

  return (
    <section className="panel min-w-0" aria-label="Awaiting you">
      <PanelHead
        title="Awaiting you"
        count={pager.state === "ready" ? pageCount(pager.data) : undefined}
        to="/runs"
        search={{ status: "awaiting" }}
        link="All awaiting runs"
      />
      <Load value={pager} pending={<Note>Loading.</Note>}>
        {(page) =>
          page.rows.length === 0 ? (
            <Note>No run is waiting on a person.</Note>
          ) : (
            <ul>
              {page.rows.filter(isWaiting).map((run) => (
                <AwaitingRow key={run.id} run={run} now={now} />
              ))}
            </ul>
          )
        }
      </Load>
    </section>
  );
}

export function RunningNow({ now }: { now: number }) {
  const pager = useRunPages({ status: "running" }, LIST_PAGE);

  return (
    <section className="panel min-w-0" aria-label="Running now">
      <PanelHead
        title="Running now"
        count={pager.state === "ready" ? pageCount(pager.data) : undefined}
        to="/runs"
        search={{ status: "running" }}
        link="All running runs"
      />
      <Load value={pager} pending={<Note>Loading.</Note>}>
        {(page) =>
          page.rows.length === 0 ? (
            <Note>Nothing is running.</Note>
          ) : (
            <ul>
              {page.rows.map((run) => (
                <li
                  key={run.id}
                  className="relative flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0 hover:bg-hover"
                >
                  <RunPill run={run} small />
                  <Link
                    to="/runs/$runId"
                    params={{ runId: run.id }}
                    className="row-link min-w-0 truncate font-medium"
                  >
                    {run.loopy.slug}{" "}
                    <span className="font-mono text-xs font-normal text-muted">
                      {shortId(run.id)}
                    </span>
                  </Link>
                  {run.ownerStale && (
                    <span className="text-xs text-attention">Owner stopped heartbeating</span>
                  )}
                  <span className="ml-auto text-xs text-muted tabular-nums">
                    {elapsed(runElapsed(run, now))}
                  </span>
                </li>
              ))}
            </ul>
          )
        }
      </Load>
    </section>
  );
}

const NEXT_COUNT = 6;

/**
 * The overview read spans every workspace. A loopy page resolves its slug to one workspace, so a
 * schedule whose workspace is not that one links to its own row on Schedules instead.
 */
export function NextScheduled({ now }: { now: number }) {
  const overview = useScheduleOverview();
  const loopies = useLoopyRows();

  const opensLoopy = (slug: string, workspace: string) =>
    loopies.state === "ready" &&
    loopies.data.some((loopy) => loopy.slug === slug && loopy.workspace === workspace);

  return (
    <section className="panel min-w-0" aria-label="Next scheduled">
      <PanelHead title="Next scheduled" to="/schedules" link="Schedules" />
      <Load value={overview} pending={<Note>Loading.</Note>}>
        {(data) =>
          data.next.length === 0 ? (
            <Note>No schedule is active.</Note>
          ) : (
            <ul>
              {data.next.slice(0, NEXT_COUNT).map((schedule) => (
                <li
                  key={`${schedule.workspace}:${schedule.slug}`}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0"
                >
                  <span className="min-w-0">
                    {opensLoopy(schedule.slug, schedule.workspace) ? (
                      <Link
                        to="/loopies/$slug"
                        params={{ slug: schedule.slug }}
                        className="cell-main text-ink hover:text-active"
                      >
                        {schedule.slug}
                      </Link>
                    ) : (
                      <Link
                        to="/schedules"
                        search={{ workspace: schedule.workspace, slug: schedule.slug }}
                        className="cell-main text-ink hover:text-active"
                        title={schedule.workspace}
                      >
                        {schedule.slug}
                      </Link>
                    )}
                    <span className="cell-sub">{describeCron(schedule.cron) ?? schedule.cron}</span>
                  </span>
                  <span className="text-right">
                    <FireTime at={schedule.nextFireAt} now={now} />
                  </span>
                </li>
              ))}
            </ul>
          )
        }
      </Load>
    </section>
  );
}
