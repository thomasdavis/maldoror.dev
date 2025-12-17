import { makeWorkerUtils, type WorkerUtils, type Job } from 'graphile-worker';

let workerUtils: WorkerUtils | null = null;

/**
 * Get or create the worker utils (singleton)
 */
export async function getWorkerUtils(): Promise<WorkerUtils> {
  if (!workerUtils) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is required');
    }

    workerUtils = await makeWorkerUtils({
      connectionString,
    });
  }
  return workerUtils;
}

/**
 * Avatar generation job payload
 */
export interface AvatarGeneratePayload {
  avatarId: string;
  userId: string;
  prompt: string;
  vibe?: string;
}

/**
 * Add an avatar generation job to the queue
 */
export async function addAvatarGenerateJob(
  payload: AvatarGeneratePayload,
  options?: {
    runAt?: Date;
    maxAttempts?: number;
    priority?: number;
  }
): Promise<Job> {
  const utils = await getWorkerUtils();
  return utils.addJob('avatar:generate', payload, options);
}

/**
 * Clean up worker utils
 */
export async function releaseWorkerUtils(): Promise<void> {
  if (workerUtils) {
    await workerUtils.release();
    workerUtils = null;
  }
}
