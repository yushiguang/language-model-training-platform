import type {Platform} from '../../contracts/src/infra-api';
import {localDocRuntime} from './standins/local-db';
import {sampleExamples} from './standins/sample-examples';
import {simulatedModels} from './standins/simulated-models';
import {scriptedAgent} from './standins/scripted-agent';
import {browserFiles, localIdentity} from './standins/local';

/**
 * THE infrastructure integration point (`packages/infra/src/config.ts`).
 *
 * In the public repository, this wires browser/local stand-ins so external agents can run
 * and test the entire application without internal credentials.
 * During internal builds, the overlay in `internal/config/config.ts` replaces this file with
 * real company infrastructure adapters.
 */
export function createPlatform(): Platform {
  return {
    db: localDocRuntime(),
    models: simulatedModels(),
    agent: scriptedAgent(),
    identity: localIdentity(),
    files: browserFiles(),
    examples: sampleExamples(process.env.NEXT_PUBLIC_BASE_PATH ?? ''),
    standIns: ['storage', 'labeling models', 'agent model', 'identity', 'files', 'examples'],
  };
}

let platform: Platform | null = null;
export const getPlatform = () => (platform ??= createPlatform());
