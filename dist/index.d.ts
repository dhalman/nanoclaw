import './channels/index.js';
import { RegisteredGroup } from './types.js';
/** @internal - wraps snapshots.getAvailableGroups with module state. Used by routing.test.ts. */
export declare function getAvailableGroups(): import('./snapshots.js').AvailableGroup[];
/** @internal - exported for testing */
export declare function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void;
//# sourceMappingURL=index.d.ts.map