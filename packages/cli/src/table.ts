import type { Command } from "./command";
import { cancel } from "./commands/cancel";
import { daemonInstall, daemonRun, daemonStatus, daemonUninstall } from "./commands/daemon";
import { graph } from "./commands/graph";
import { hook } from "./commands/hook";
import { inspect } from "./commands/inspect";
import { list } from "./commands/list";
import { logs } from "./commands/logs";
import { resume } from "./commands/resume";
import { run } from "./commands/run";
import { runs } from "./commands/runs";
import { save } from "./commands/save";
import { schedule } from "./commands/schedule";
import { secretsList, secretsRemove, secretsSet } from "./commands/secrets";
import { types } from "./commands/types";
import { ui } from "./commands/ui";

/** Usage lists commands in this order. */
export const COMMANDS: readonly Command[] = [
  graph,
  save,
  list,
  run,
  runs,
  inspect,
  logs,
  hook,
  resume,
  cancel,
  schedule,
  daemonRun,
  daemonInstall,
  daemonUninstall,
  daemonStatus,
  types,
  secretsSet,
  secretsList,
  secretsRemove,
  ui,
];
