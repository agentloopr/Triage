/**
 * All configuration, read once, every value defaulted.
 *
 * The rule carried over from production: this module NEVER throws at import time. A missing key
 * makes the provider that needs it fail loudly when called, with a message naming the variable —
 * it does not prevent the process from starting, and it does not stop the cassette-driven demo
 * (which needs no keys at all) from running.
 */
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';

loadDotenv();

const str = (k: string, dflt: string): string => process.env[k]?.trim() || dflt;
const int = (k: string, dflt: number): number => {
  const n = Number.parseInt(process.env[k] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
const num = (k: string, dflt: number): number => {
  const n = Number.parseFloat(process.env[k] ?? '');
  return Number.isFinite(n) ? n : dflt;
};
/** Defaults to `dflt` unless explicitly set — an unset safety flag must never read as "off". */
const bool = (k: string, dflt: boolean): boolean => {
  const v = process.env[k]?.trim().toLowerCase();
  if (v === undefined || v === '') return dflt;
  return v === '1' || v === 'true' || v === 'yes';
};

// ── Model providers ─────────────────────────────────────────────────────────
export const MODEL_PROVIDER = str('MODEL_PROVIDER', 'cassette');

export const DEEPSEEK_API_KEY = str('DEEPSEEK_API_KEY', '');
export const DEEPSEEK_BASE_URL = str('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1');
export const DEEPSEEK_MODEL = str('DEEPSEEK_MODEL', 'deepseek-v4-pro');
export const DEEPSEEK_MAX_OUTPUT_TOKENS = int('DEEPSEEK_MAX_OUTPUT_TOKENS', 16_384);

export const ANTHROPIC_API_KEY = str('ANTHROPIC_API_KEY', '');
/** Env-driven on purpose — a hardcoded model id 404s the day the provisioned model changes. */
export const ANTHROPIC_MODEL = str('ANTHROPIC_MODEL', 'claude-opus-5');
export const ANTHROPIC_MAX_OUTPUT_TOKENS = int('ANTHROPIC_MAX_OUTPUT_TOKENS', 16_384);

/** Total wall-clock budget for one completion including retries. */
export const MODEL_TIMEOUT_MS = int('MODEL_TIMEOUT_MS', 600_000);

// ── Tracker ─────────────────────────────────────────────────────────────────
export const TRACKER = str('TRACKER', 'memory');
export const CLICKUP_API_TOKEN = str('CLICKUP_API_TOKEN', '');
export const CLICKUP_TEAM_ID = str('CLICKUP_TEAM_ID', '');
export const LINEAR_API_KEY = str('LINEAR_API_KEY', '');

// ── Routing ─────────────────────────────────────────────────────────────────
/**
 * The list work lands on when nothing else matches. Optional and **empty by default**: when set, an
 * item routed here at LOW confidence is treated as "the entity in this item may be unrecognized" and
 * asked about rather than written. Leave it unset and the check simply never fires.
 */
export const CATCH_ALL_LIST_KEY = str('CATCH_ALL_LIST_KEY', '');

/** Below this source confidence, an `unsure` legitimacy verdict is held rather than guessed at. */
export const ASR_PROVENANCE_LOW = num('ASR_PROVENANCE_LOW', 0.75);
/** Below this, the source is too garbled to act on at all. */
export const ASR_PROVENANCE_FLOOR = num('ASR_PROVENANCE_FLOOR', 0.5);

/** When the registry is degraded, hold the entire batch rather than writing against an empty roster. */
export const REGISTRY_FAIL_CLOSED = bool('REGISTRY_FAIL_CLOSED', true);

// ── Paths ───────────────────────────────────────────────────────────────────
export const OPS_REGISTRY_PATH = resolve(str('OPS_REGISTRY_PATH', './config/ops-registry.json'));
export const STATE_DIR = resolve(str('STATE_DIR', './.state'));
export const CORRECTIONS_PATH = resolve(str('CORRECTIONS_PATH', `${STATE_DIR}/corrections.json`));
export const CASSETTE_DIR = resolve(str('CASSETTE_DIR', './fixtures/cassettes'));
