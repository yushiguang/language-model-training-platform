import type {Platform} from './interfaces';
import {pgliteSql} from './standins/pglite-sql';
import {sampleExamples} from './standins/sample-examples';
import {simulatedBatch, simulatedModels} from './standins/simulated-models';
import {scriptedAgent} from './standins/scripted-agent';
import {browserFiles, localIdentity} from './standins/local';

/**
 * THE integration point. Replace each stand-in with an adapter for the real service
 * (docs/handover/integration.md lists what each one must do). Nothing else in the app
 * needs to change.
 */
export function createPlatform(): Platform {
  return {
    sql: pgliteSql(),
    models: simulatedModels(),
    batch: simulatedBatch(),
    agent: scriptedAgent(),
    identity: localIdentity(),
    files: browserFiles(),
    examples: sampleExamples(process.env.NEXT_PUBLIC_BASE_PATH ?? ''),
    standIns: ['storage', 'labeling models', 'batch jobs', 'agent model', 'identity', 'files', 'examples'],
  };
}

let platform: Platform | null = null;
export const getPlatform = () => (platform ??= createPlatform());
