import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import type { users, userKeys } from './users.js';
import type { avatars, avatarJobs } from './avatars.js';
import type { world, chunkDeltas } from './world.js';
import type { playerState, sessions, gameEvents } from './sessions.js';

// User types
export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;
export type UserKey = InferSelectModel<typeof userKeys>;
export type NewUserKey = InferInsertModel<typeof userKeys>;

// Avatar types
export type Avatar = InferSelectModel<typeof avatars>;
export type NewAvatar = InferInsertModel<typeof avatars>;
export type AvatarJob = InferSelectModel<typeof avatarJobs>;
export type NewAvatarJob = InferInsertModel<typeof avatarJobs>;

// World types
export type World = InferSelectModel<typeof world>;
export type NewWorld = InferInsertModel<typeof world>;
export type ChunkDelta = InferSelectModel<typeof chunkDeltas>;
export type NewChunkDelta = InferInsertModel<typeof chunkDeltas>;

// Session types
export type PlayerState = InferSelectModel<typeof playerState>;
export type NewPlayerState = InferInsertModel<typeof playerState>;
export type Session = InferSelectModel<typeof sessions>;
export type NewSession = InferInsertModel<typeof sessions>;
export type GameEvent = InferSelectModel<typeof gameEvents>;
export type NewGameEvent = InferInsertModel<typeof gameEvents>;
