import type { TaskList } from 'graphile-worker';
import { avatarGenerate } from './avatar-generate.js';

/**
 * All registered tasks
 */
export const taskList: TaskList = {
  'avatar:generate': avatarGenerate,
};
