import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import type { ProcessManager } from '../tools/processes.js';
import type { TicketStore } from '../transfer/tickets.js';

export interface ServerDeps {
  config: Config;
  log: Logger;
  tickets: TicketStore;
  processes: ProcessManager;

  baseUrl: () => string;

  publicUrl: () => string | undefined;
  startedAt: number;
}
