/**
 * Provider selection. Defaults to `cassette` so a clone with no `.env` at all still runs the demo.
 */
import { join } from 'node:path';
import { CASSETTE_DIR, MODEL_PROVIDER } from '../config';
import { type ModelClient } from './index';
import { anthropicClient } from './anthropic';
import { cassetteClient } from './cassette';
import { deepseekClient } from './deepseek';

export type ProviderName = 'cassette' | 'deepseek' | 'anthropic';

export interface ProviderOptions {
  provider?: ProviderName | string;
  /** Required for the cassette provider — cassettes are stored per scenario. */
  scenario?: string;
  /** Record misses through this live provider instead of throwing. */
  record?: ProviderName;
}

export function makeModelClient(opts?: ProviderOptions): ModelClient {
  const name = (opts?.provider ?? MODEL_PROVIDER) as ProviderName;

  switch (name) {
    case 'deepseek':
      return deepseekClient();
    case 'anthropic':
      return anthropicClient();
    case 'cassette': {
      if (!opts?.scenario) throw new Error('cassette provider needs a scenario name');
      return cassetteClient(join(CASSETTE_DIR, opts.scenario), {
        ...(opts.record ? { record: live(opts.record) } : {}),
      });
    }
    default:
      throw new Error(`unknown MODEL_PROVIDER "${name}" — expected cassette | deepseek | anthropic`);
  }
}

function live(name: ProviderName): ModelClient {
  if (name === 'deepseek') return deepseekClient();
  if (name === 'anthropic') return anthropicClient();
  throw new Error(`cannot record through "${name}" — pick deepseek or anthropic`);
}
