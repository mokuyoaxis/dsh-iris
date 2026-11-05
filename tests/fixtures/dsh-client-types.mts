import type { DshClientPlugin } from '@mokuyoaxis/dsh-iris/client';

const hostFactory: DshClientPlugin = { inject: ['slots'], apply(ctx) { void ctx; } };
type BrowserEntry = typeof import('@mokuyoaxis/dsh-iris/client');
declare const entry: BrowserEntry;
// @ts-expect-error The browser entry registers a DSH factory; it has no Node default value.
void entry.default;
// @ts-expect-error The factory shape is a type, not a runtime ESM export.
void entry.DshClientPlugin;
void hostFactory;
