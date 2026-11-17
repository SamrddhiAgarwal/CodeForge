import { EventEmitter } from 'node:events';

// One API process: REST changes notify its Socket.IO connections directly.
export const projectEvents = new EventEmitter();
