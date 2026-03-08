/**
 * Defines the strict message contract for all iframe ↔ shell communication.
 * Every postMessage payload MUST conform to this interface.
 */
export interface IframeMessage {
  /** Discriminated union – determines how the payload is interpreted. */
  type:
    | 'KPI_SELECTED'
    | 'KPI_FOCUSED'
    | 'DATA_UPDATE'
    | 'CRASH_SIMULATION'
    | 'PING'
    | 'PONG'
    | 'KILL'
    | 'TOGGLE_CRASH_BTN'
    | 'HOLD';

  /** Routing: who should act on this message. */
  target: 'SHELL' | 'KPI_APP' | 'AI_APP' | 'WEATHER_APP';

  /** Arbitrary data attached to the message. */
  payload: unknown;
}

/**
 * Health status for each iframe tracked by the heartbeat system.
 *  - 'online'     → responding to PINGs normally
 *  - 'offline'    → missed 2+ consecutive PINGs
 *  - 'recovering' → iframe reload in progress
 */
export type IframeHealthStatus = 'online' | 'offline' | 'recovering';

/** The two layout states the shell can be in. */
export type LayoutState = 'overview' | 'focus';
